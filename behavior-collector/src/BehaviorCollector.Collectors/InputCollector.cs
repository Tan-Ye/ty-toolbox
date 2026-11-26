using System.Text.Json;
using BehaviorCollector.Collectors.Privacy;
using BehaviorCollector.Collectors.Win32;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Diagnostics;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Privacy;
using BehaviorCollector.Core.Util;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SharpHook;
using SharpHook.Data;

namespace BehaviorCollector.Collectors;

/// <summary>
/// 全局键鼠采集：按键只存 HMAC，鼠标移动降采样到 20Hz，点击/滚轮全记录，空闲与排除应用不采集。
/// </summary>
public sealed class InputCollector : BackgroundService
{
    private readonly EventBus _bus;
    private readonly ConfigService _config;
    private readonly ForegroundState _foreground;
    private readonly PrivacyPolicy _privacy;
    private readonly PauseState _pause;
    private readonly IdleDetector _idle;
    private readonly KeyHasher _keyHasher;
    private readonly PlaintextPolicy _plaintext;
    private readonly InputHookStatusStore _hookStatus;
    private readonly ILogger<InputCollector> _logger;

    private readonly object _cacheGate = new();
    private readonly Dictionary<IntPtr, (WindowSnapshot Info, long At)> _windowCache = new();
    private long _lastMoveTicks;
    private int _lastX = -1;
    private int _lastY = -1;

    public InputCollector(
        EventBus bus,
        ConfigService config,
        ForegroundState foreground,
        PrivacyPolicy privacy,
        PauseState pause,
        IdleDetector idle,
        KeyHasher keyHasher,
        PlaintextPolicy plaintext,
        InputHookStatusStore hookStatus,
        ILogger<InputCollector> logger)
    {
        _bus = bus;
        _config = config;
        _foreground = foreground;
        _privacy = privacy;
        _pause = pause;
        _idle = idle;
        _keyHasher = keyHasher;
        _plaintext = plaintext;
        _hookStatus = hookStatus;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _hookStatus.SetState(InputHookStates.Starting);

        EventLoopGlobalHook? hook = null;
        Task runTask;
        try
        {
            hook = new EventLoopGlobalHook();
            hook.KeyPressed += OnKeyPressed;
            hook.MousePressed += (_, e) => OnMouseButton(e, "down");
            hook.MouseReleased += (_, e) => OnMouseButton(e, "up");
            hook.MouseWheel += OnMouseWheel;
            hook.MouseMoved += OnMouseMoved;
            hook.HookEnabled += OnHookEnabled;
            hook.HookDisabled += OnHookDisabled;

            runTask = hook.RunAsync();
            _logger.LogInformation("全局键鼠钩子启动请求已提交");
        }
        catch (Exception ex)
        {
            _hookStatus.SetState(InputHookStates.Faulted, $"{ex.GetType().Name}: {ex.Message}");
            _logger.LogError(ex, "全局键鼠钩子启动失败，输入采集不可用");
            hook?.Dispose();
            return;
        }

        _ = MonitorHookAsync(runTask, stoppingToken);

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            if (hook is not null)
            {
                hook.KeyPressed -= OnKeyPressed;
                hook.HookEnabled -= OnHookEnabled;
                hook.HookDisabled -= OnHookDisabled;
                hook.Dispose();
            }

            try
            {
                await runTask.WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch (Exception)
            {
                // 停止超时忽略。
            }

            var finalState = _hookStatus.Current.State == InputHookStates.Faulted
                ? InputHookStates.Faulted
                : InputHookStates.Stopped;
            _hookStatus.SetState(finalState);
            _logger.LogInformation("全局键鼠钩子已停止");
        }
    }

    private void OnHookEnabled(object? sender, HookEventArgs e)
    {
        _hookStatus.SetState(InputHookStates.Running);
        _logger.LogInformation("全局键鼠钩子已启用");
    }

    private void OnHookDisabled(object? sender, HookEventArgs e)
    {
        _hookStatus.SetState(InputHookStates.Stopped, "hook disabled");
        _logger.LogWarning("全局键鼠钩子已禁用，输入采集停止");
    }

    private async Task MonitorHookAsync(Task runTask, CancellationToken stoppingToken)
    {
        try
        {
            await runTask.ConfigureAwait(false);
            if (!stoppingToken.IsCancellationRequested)
            {
                _hookStatus.SetState(InputHookStates.Stopped, "hook loop exited");
                _logger.LogWarning("全局键鼠钩子循环已退出，输入采集停止");
            }
        }
        catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
        {
            _hookStatus.SetState(InputHookStates.Faulted, $"{ex.GetType().Name}: {ex.Message}");
            _logger.LogError(ex, "全局键鼠钩子异常退出，输入采集不可用");
        }
        catch (Exception)
        {
            // 停止过程中的取消/异常不再上报。
        }
    }

    private void OnKeyPressed(object? sender, KeyboardHookEventArgs e)
    {
        try
        {
            if (ShouldSkipInput())
            {
                return;
            }

            var foreground = _foreground.Current;
            if (foreground is null || foreground.Excluded)
            {
                return;
            }

            var modifiers = (uint)(e.RawEvent.Mask &
                                   (EventMask.Shift | EventMask.Ctrl | EventMask.Alt | EventMask.Meta));
            var data = JsonSerializer.Serialize(new
            {
                vk_hash = _keyHasher.Hash(e.Data.RawCode, modifiers),
                mods = modifiers,
            }, JsonDefaults.Compact);

            _bus.Emit(new EventRecord
            {
                Kind = "input.key",
                Source = "input",
                Pid = foreground.Pid,
                Hwnd = foreground.Hwnd.ToInt64(),
                App = foreground.App,
                Title = foreground.Title,
                Session = Win32Util.CurrentSessionId,
                Data = data,
                KeyPlain = _plaintext.Enabled ? e.Data.KeyCode.ToString() : null,
            });
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "处理按键事件失败");
        }
    }

    private void OnMouseButton(MouseHookEventArgs e, string action)
    {
        try
        {
            if (ShouldSkipInput())
            {
                return;
            }

            var x = e.Data.X;
            var y = e.Data.Y;
            var target = ResolveAt(x, y);
            if (target is null || _privacy.Matcher.IsExcluded(target.App, target.Title))
            {
                return;
            }

            var data = JsonSerializer.Serialize(new
            {
                x,
                y,
                button = ButtonName(e.Data.Button),
                action,
            }, JsonDefaults.Compact);

            EmitWithWindow("input.click", target, data);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "处理鼠标点击失败");
        }
    }

    private void OnMouseWheel(object? sender, MouseWheelHookEventArgs e)
    {
        try
        {
            if (ShouldSkipInput())
            {
                return;
            }

            var x = e.Data.X;
            var y = e.Data.Y;
            var target = ResolveAt(x, y);
            if (target is null || _privacy.Matcher.IsExcluded(target.App, target.Title))
            {
                return;
            }

            var data = JsonSerializer.Serialize(new
            {
                x,
                y,
                rotation = (int)e.Data.Rotation,
                delta = (int)e.Data.Delta,
                direction = e.Data.Direction.ToString().ToLowerInvariant(),
            }, JsonDefaults.Compact);

            EmitWithWindow("input.wheel", target, data);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "处理鼠标滚轮失败");
        }
    }

    private void OnMouseMoved(object? sender, MouseHookEventArgs e)
    {
        try
        {
            if (ShouldSkipInput())
            {
                return;
            }

            var hz = Math.Clamp(_config.Current.Input.MouseMoveHz, 1, 60);
            var interval = 1000 / hz;
            var now = Environment.TickCount64;
            if (now - _lastMoveTicks < interval)
            {
                return;
            }

            var x = e.Data.X;
            var y = e.Data.Y;
            if (x == _lastX && y == _lastY)
            {
                return;
            }

            _lastMoveTicks = now;
            _lastX = x;
            _lastY = y;

            var target = ResolveAt(x, y);
            if (target is null || _privacy.Matcher.IsExcluded(target.App, target.Title))
            {
                return;
            }

            var data = JsonSerializer.Serialize(new { x, y }, JsonDefaults.Compact);
            EmitWithWindow("input.move", target, data);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "处理鼠标移动失败");
        }
    }

    private bool ShouldSkipInput()
    {
        return _pause.IsPaused || _idle.IsIdle || !_config.Current.Collectors.Input;
    }

    private WindowSnapshot? ResolveAt(int x, int y)
    {
        var hwnd = Win32Util.HwndFromPoint(x, y);
        if (hwnd == IntPtr.Zero)
        {
            return null;
        }

        var now = Environment.TickCount64;
        lock (_cacheGate)
        {
            if (_windowCache.TryGetValue(hwnd, out var cached) && now - cached.At < 2000)
            {
                return cached.Info;
            }
        }

        var info = Win32Util.TryGetWindow(hwnd);
        if (info is null)
        {
            return null;
        }

        lock (_cacheGate)
        {
            if (_windowCache.Count > 512)
            {
                _windowCache.Clear();
            }

            _windowCache[hwnd] = (info, now);
        }

        return info;
    }

    private void EmitWithWindow(string kind, WindowSnapshot target, string data)
    {
        _bus.Emit(new EventRecord
        {
            Kind = kind,
            Source = "input",
            Pid = target.Pid,
            Hwnd = target.Hwnd.ToInt64(),
            App = target.App,
            Title = target.Title,
            Session = Win32Util.CurrentSessionId,
            Data = data,
        });
    }

    private static string ButtonName(MouseButton button) => button switch
    {
        MouseButton.Button1 => "left",
        MouseButton.Button2 => "right",
        MouseButton.Button3 => "middle",
        MouseButton.Button4 => "x1",
        MouseButton.Button5 => "x2",
        _ => "none",
    };
}

using System.Text.Json;
using BehaviorCollector.Collectors.Privacy;
using BehaviorCollector.Collectors.Win32;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Privacy;
using BehaviorCollector.Core.Util;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Accessibility;

namespace BehaviorCollector.Collectors;

/// <summary>
/// 前台窗口采集：SetWinEventHook（独立消息循环线程）+ 1s 轮询兜底。
/// 窗口没有变化时每 60 秒补一条 window.foreground 心跳，让下游能区分「一直在这个窗口」和「采集断了」。
/// </summary>
public sealed class WindowCollector : BackgroundService
{
    private const long HeartbeatMs = 60_000;

    private readonly EventBus _bus;
    private readonly ConfigService _config;
    private readonly ForegroundState _foreground;
    private readonly PrivacyPolicy _privacy;
    private readonly PauseState _pause;
    private readonly IdleDetector _idle;
    private readonly ILogger<WindowCollector> _logger;

    private readonly object _gate = new();
    private Thread? _hookThread;
    private ManualResetEventSlim? _hookReady;
    private uint _hookThreadId;
    private WINEVENTPROC? _hookCallback;

    private IntPtr _lastHwnd;
    private string? _lastTitle;
    private long _lastHeartbeat;

    public WindowCollector(
        EventBus bus,
        ConfigService config,
        ForegroundState foreground,
        PrivacyPolicy privacy,
        PauseState pause,
        IdleDetector idle,
        ILogger<WindowCollector> logger)
    {
        _bus = bus;
        _config = config;
        _foreground = foreground;
        _privacy = privacy;
        _pause = pause;
        _idle = idle;
        _logger = logger;
        _pause.Changed += OnPauseChanged;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            if (!_config.Current.Collectors.Window)
            {
                _logger.LogInformation("窗口采集已在配置中关闭");
                return;
            }

            StartHookThread();
            while (!stoppingToken.IsCancellationRequested)
            {
                UpdateForeground((IntPtr)PInvoke.GetForegroundWindow());
                try
                {
                    await Task.Delay(1000, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
        finally
        {
            StopHookThread();
            _pause.Changed -= OnPauseChanged;
        }
    }

    private void StartHookThread()
    {
        _hookReady = new ManualResetEventSlim(false);
        _hookThread = new Thread(HookThreadProc)
        {
            IsBackground = true,
            Name = "WindowEventHook",
        };
        _hookThread.Start();
        if (!_hookReady.Wait(TimeSpan.FromSeconds(3)))
        {
            _logger.LogWarning("窗口事件钩子启动超时，仅使用轮询兜底");
        }
    }

    private void HookThreadProc()
    {
        try
        {
            _hookThreadId = PInvoke.GetCurrentThreadId();
            _hookCallback = OnWinEvent;
            using var foregroundHook = PInvoke.SetWinEventHook(
                Win32Util.EVENT_SYSTEM_FOREGROUND, Win32Util.EVENT_SYSTEM_FOREGROUND,
                null, _hookCallback, 0, 0, Win32Util.WINEVENT_OUTOFCONTEXT);
            using var titleHook = PInvoke.SetWinEventHook(
                Win32Util.EVENT_OBJECT_NAMECHANGE, Win32Util.EVENT_OBJECT_NAMECHANGE,
                null, _hookCallback, 0, 0, Win32Util.WINEVENT_OUTOFCONTEXT);

            _hookReady?.Set();

            if (foregroundHook.IsInvalid && titleHook.IsInvalid)
            {
                _logger.LogWarning("SetWinEventHook 安装失败，仅使用轮询兜底");
                return;
            }

            while (PInvoke.GetMessage(out var msg, default, 0, 0))
            {
                PInvoke.TranslateMessage(msg);
                PInvoke.DispatchMessage(msg);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "窗口事件钩子线程异常");
        }
        finally
        {
            _hookReady?.Set();
        }
    }

    private void StopHookThread()
    {
        if (_hookThread is null)
        {
            return;
        }

        if (_hookThreadId != 0)
        {
            PInvoke.PostThreadMessage(_hookThreadId, Win32Util.WM_QUIT, default, default);
        }

        _hookThread.Join(TimeSpan.FromSeconds(3));
        _hookThread = null;
        _hookReady?.Dispose();
        _hookReady = null;
    }

    private void OnWinEvent(HWINEVENTHOOK hook, uint eventId, HWND hwnd, int idObject, int idChild,
        uint idEventThread, uint eventTime)
    {
        try
        {
            if (hwnd.IsNull)
            {
                return;
            }

            if (eventId == Win32Util.EVENT_OBJECT_NAMECHANGE)
            {
                var foreground = PInvoke.GetForegroundWindow();
                if (foreground != hwnd)
                {
                    return;
                }
            }

            UpdateForeground((IntPtr)hwnd);
        }
        catch (Exception)
        {
            // 钩子回调里绝不抛异常。
        }
    }

    private void OnPauseChanged(bool paused)
    {
        if (paused)
        {
            return;
        }

        try
        {
            UpdateForeground((IntPtr)PInvoke.GetForegroundWindow(), force: true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "恢复采集时刷新前台窗口失败");
        }
    }

    private void UpdateForeground(IntPtr hwnd, bool force = false)
    {
        var info = Win32Util.TryGetWindow(hwnd);
        if (info is null)
        {
            return;
        }

        var excluded = _privacy.Matcher.IsExcluded(info.App, info.Title);
        _foreground.Update(new ForegroundSnapshot(info.Hwnd, info.Pid, info.App, info.Title, excluded));

        lock (_gate)
        {
            var now = Environment.TickCount64;
            var hwndChanged = info.Hwnd != _lastHwnd;
            var titleChanged = !string.Equals(info.Title, _lastTitle, StringComparison.Ordinal);
            // 空闲时不算活跃：没有心跳，分析器只能把最后一段截到「最后一次确认 + 10 分钟」
            var heartbeatDue = !_idle.IsIdle && now - _lastHeartbeat >= HeartbeatMs;
            if (!hwndChanged && !titleChanged && !force && !heartbeatDue)
            {
                return;
            }

            _lastHwnd = info.Hwnd;
            _lastTitle = info.Title;

            if (_pause.IsPaused)
            {
                return;
            }

            if (hwndChanged || force || heartbeatDue)
            {
                Emit("window.foreground", info);
                _lastHeartbeat = now;
            }
            else if (titleChanged && !excluded)
            {
                Emit("window.title", info);
            }
        }
    }

    private void Emit(string kind, WindowSnapshot info)
    {
        var data = JsonSerializer.Serialize(new
        {
            @class = info.ClassName,
            rect = new[] { info.Left, info.Top, info.Right, info.Bottom },
            monitor = info.Monitor.ToInt64(),
            monitor_primary = info.MonitorPrimary,
            fullscreen = info.IsFullscreen,
        }, JsonDefaults.Compact);

        _bus.Emit(new EventRecord
        {
            Kind = kind,
            Source = "window",
            Pid = info.Pid,
            Hwnd = info.Hwnd.ToInt64(),
            App = info.App,
            Title = info.Title,
            Session = Win32Util.CurrentSessionId,
            Data = data,
        });
    }
}

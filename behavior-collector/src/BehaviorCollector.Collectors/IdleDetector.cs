using System.Text.Json;
using BehaviorCollector.Collectors.Win32;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Privacy;
using BehaviorCollector.Core.Util;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Windows.Win32;
using Windows.Win32.UI.Input.KeyboardAndMouse;

namespace BehaviorCollector.Collectors;

/// <summary>
/// 空闲检测：GetLastInputInfo 每 5s 检查，超过阈值发 idle.start，恢复发 idle.end。
/// </summary>
public sealed class IdleDetector : BackgroundService
{
    private readonly EventBus _bus;
    private readonly ConfigService _config;
    private readonly PauseState _pause;
    private readonly ILogger<IdleDetector> _logger;

    private int _isIdle;
    private int _idleMilliseconds;
    private long _idleStartedAtMs;

    public IdleDetector(
        EventBus bus,
        ConfigService config,
        PauseState pause,
        ILogger<IdleDetector> logger)
    {
        _bus = bus;
        _config = config;
        _pause = pause;
        _logger = logger;
    }

    public bool IsIdle => Volatile.Read(ref _isIdle) != 0;

    public int IdleMilliseconds => Volatile.Read(ref _idleMilliseconds);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                Tick();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "空闲检测失败");
            }

            try
            {
                await Task.Delay(5000, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private void Tick()
    {
        if (!TryGetIdleMilliseconds(out var idleMs))
        {
            return;
        }

        Volatile.Write(ref _idleMilliseconds, idleMs);
        var thresholdMs = _config.Current.Input.IdleThresholdSeconds * 1000;
        var idle = Volatile.Read(ref _isIdle) != 0;

        if (!idle && idleMs >= thresholdMs)
        {
            Volatile.Write(ref _isIdle, 1);
            _idleStartedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!_pause.IsPaused)
            {
                Emit("idle.start", new { idle_ms = idleMs, threshold_s = thresholdMs / 1000 });
            }
        }
        else if (idle && idleMs < thresholdMs)
        {
            Volatile.Write(ref _isIdle, 0);
            if (!_pause.IsPaused)
            {
                var duration = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _idleStartedAtMs;
                Emit("idle.end", new { idle_ms = duration });
            }
        }
    }

    private static bool TryGetIdleMilliseconds(out int idleMs)
    {
        var info = new LASTINPUTINFO { cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<LASTINPUTINFO>() };
        if (!PInvoke.GetLastInputInfo(ref info))
        {
            idleMs = 0;
            return false;
        }

        var current = unchecked((uint)Environment.TickCount);
        idleMs = (int)unchecked(current - info.dwTime);
        if (idleMs < 0)
        {
            idleMs = 0;
        }

        return true;
    }

    private void Emit(string kind, object data)
    {
        _bus.Emit(new EventRecord
        {
            Kind = kind,
            Source = "input",
            Session = Win32Util.CurrentSessionId,
            Data = JsonSerializer.Serialize(data, JsonDefaults.Compact),
        });
    }
}

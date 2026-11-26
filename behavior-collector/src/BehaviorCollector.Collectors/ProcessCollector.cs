using System.Text.Json;
using BehaviorCollector.Collectors.Win32;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Privacy;
using BehaviorCollector.Core.Util;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BehaviorCollector.Collectors;

/// <summary>
/// 进程启停：Toolhelp32 每 2s 快照，与上次 diff。首次快照只建基线，不产生事件。
/// </summary>
public sealed class ProcessCollector : BackgroundService
{
    private readonly EventBus _bus;
    private readonly ConfigService _config;
    private readonly PauseState _pause;
    private readonly ILogger<ProcessCollector> _logger;

    public ProcessCollector(
        EventBus bus,
        ConfigService config,
        PauseState pause,
        ILogger<ProcessCollector> logger)
    {
        _bus = bus;
        _config = config;
        _pause = pause;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_config.Current.Collectors.Process)
        {
            _logger.LogInformation("进程采集已在配置中关闭");
            return;
        }

        var previous = new Dictionary<int, ProcessSnapshot>();
        var firstScan = true;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var current = new Dictionary<int, ProcessSnapshot>(256);
                foreach (var entry in Win32Util.EnumerateProcesses())
                {
                    current[entry.Pid] = entry;
                }

                if (firstScan)
                {
                    previous = current;
                    firstScan = false;
                    _logger.LogInformation("进程快照基线已建立：{Count} 个进程", current.Count);
                }
                else
                {
                    Diff(previous, current);
                    previous = current;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "进程快照失败");
            }

            try
            {
                await Task.Delay(2000, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private void Diff(Dictionary<int, ProcessSnapshot> previous, Dictionary<int, ProcessSnapshot> current)
    {
        foreach (var (pid, entry) in current)
        {
            if (pid == Environment.ProcessId || previous.ContainsKey(pid))
            {
                continue;
            }

            var path = Win32Util.GetProcessPath(pid);
            Emit("process.start", entry, path);
        }

        foreach (var (pid, entry) in previous)
        {
            if (!current.ContainsKey(pid))
            {
                Emit("process.stop", entry, null);
            }
        }
    }

    private void Emit(string kind, ProcessSnapshot entry, string? path)
    {
        if (_pause.IsPaused || !_config.Current.Collectors.Process)
        {
            return;
        }

        var app = entry.ExeName.ToLowerInvariant();
        _logger.LogDebug("{Kind}：{App} pid={Pid}", kind, app, entry.Pid);
        var data = JsonSerializer.Serialize(new
        {
            parent_pid = entry.ParentPid,
            path,
        }, JsonDefaults.Compact);

        _bus.Emit(new EventRecord
        {
            Kind = kind,
            Source = "process",
            Pid = entry.Pid,
            App = app,
            Session = Win32Util.CurrentSessionId,
            Data = data,
        });
    }
}

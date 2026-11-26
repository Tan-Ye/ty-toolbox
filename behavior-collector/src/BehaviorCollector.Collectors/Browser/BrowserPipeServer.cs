using System.IO.Pipes;
using System.Text;
using BehaviorCollector.Collectors.Win32;
using BehaviorCollector.Core.Browser;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Privacy;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BehaviorCollector.Collectors.Browser;

/// <summary>
/// 主程序侧的命名管道服务：接收 Native Host 转发的浏览器事件，写入 EventBus。
/// </summary>
public sealed class BrowserPipeServer : BackgroundService
{
    private readonly EventBus _bus;
    private readonly ConfigService _config;
    private readonly PauseState _pause;
    private readonly ILogger<BrowserPipeServer> _logger;
    private readonly string _pipeName;

    public BrowserPipeServer(
        EventBus bus,
        ConfigService config,
        PauseState pause,
        ILogger<BrowserPipeServer> logger,
        string? pipeName = null)
    {
        _bus = bus;
        _config = config;
        _pause = pause;
        _logger = logger;
        _pipeName = pipeName ?? BrowserConstants.PipeName;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_config.Current.Collectors.Browser)
        {
            _logger.LogInformation("浏览器采集已在配置中关闭");
            return;
        }

        var consecutiveFailures = 0;

        while (!stoppingToken.IsCancellationRequested)
        {
            NamedPipeServerStream? server = null;
            try
            {
                server = new NamedPipeServerStream(
                    _pipeName,
                    PipeDirection.In,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                if (consecutiveFailures > 0)
                {
                    _logger.LogInformation("浏览器管道监听已恢复（此前连续失败 {Count} 次）", consecutiveFailures);
                    consecutiveFailures = 0;
                }

                await server.WaitForConnectionAsync(stoppingToken);

                // 连接生命周期交给处理任务，避免 using 在任务读取前就把管道关掉。
                _ = HandleClientAsync(server, stoppingToken);
                server = null;
            }
            catch (OperationCanceledException)
            {
                if (server is not null)
                {
                    await server.DisposeAsync();
                }

                break;
            }
            catch (Exception ex)
            {
                if (server is not null)
                {
                    await server.DisposeAsync();
                }

                consecutiveFailures++;
                var delay = RetryDelay(consecutiveFailures);
                if (consecutiveFailures == 1)
                {
                    _logger.LogWarning(ex, "浏览器管道监听失败，{DelaySeconds}s 后重试", delay.TotalSeconds);
                }
                else
                {
                    _logger.LogDebug(ex, "浏览器管道监听仍失败（连续 {Count} 次），{DelaySeconds}s 后重试",
                        consecutiveFailures, delay.TotalSeconds);
                }

                try
                {
                    await Task.Delay(delay, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    private static TimeSpan RetryDelay(int consecutiveFailures)
    {
        var exponent = Math.Min(Math.Max(consecutiveFailures - 1, 0), 5);
        return TimeSpan.FromSeconds(Math.Min(30, Math.Pow(2, exponent)));
    }

    private async Task HandleClientAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        await using (server)
        {
            try
            {
                using var reader = new StreamReader(server, new UTF8Encoding(false));
                while (!ct.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(ct);
                    if (line is null)
                    {
                        break;
                    }

                    if (string.IsNullOrWhiteSpace(line))
                    {
                        continue;
                    }

                    var record = BrowserEventMapper.Map(line, Win32Util.CurrentSessionId);
                    if (record is null || _pause.IsPaused || !_config.Current.Collectors.Browser)
                    {
                        continue;
                    }

                    _bus.Emit(record);
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "浏览器管道连接结束");
            }
        }
    }
}

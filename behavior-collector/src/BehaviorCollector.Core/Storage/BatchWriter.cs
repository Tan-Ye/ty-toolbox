using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Models;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BehaviorCollector.Core.Storage;

/// <summary>
/// 唯一的数据库写者：从 EventBus 批量取事件，500 条或 1s 事务刷盘；顺带做保留期清理。
/// </summary>
public sealed class BatchWriter : BackgroundService
{
    private static readonly TimeSpan MaintenanceInterval = TimeSpan.FromHours(6);

    private readonly EventBus _bus;
    private readonly AppPaths _paths;
    private readonly ConfigService _config;
    private readonly ILogger<BatchWriter> _logger;

    private long _written;
    private long _writeErrors;
    private long _lastWriteAt;
    private long _lastMaintenanceTicks;

    public BatchWriter(EventBus bus, AppPaths paths, ConfigService config, ILogger<BatchWriter> logger)
    {
        _bus = bus;
        _paths = paths;
        _config = config;
        _logger = logger;
    }

    public long WrittenCount => Interlocked.Read(ref _written);
    public long WriteErrorCount => Interlocked.Read(ref _writeErrors);

    public DateTimeOffset? LastWriteAt
    {
        get
        {
            var ts = Interlocked.Read(ref _lastWriteAt);
            return ts > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(ts) : null;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var conn = Database.CreateConnection(_paths.DatabasePath);
        using var cmd = EventInserter.CreateInsertCommand(conn);
        _logger.LogInformation("批量写入已启动：{Path}", _paths.DatabasePath);

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                EventRecord? first = null;
                try
                {
                    if (await _bus.Reader.WaitToReadAsync(stoppingToken))
                    {
                        _bus.Reader.TryRead(out first);
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }

                if (first is null)
                {
                    break;
                }

                var batch = new List<EventRecord>(_config.Current.Batch.MaxBatch) { first };
                await FillBatchAsync(batch, stoppingToken);
                WriteBatch(conn, cmd, batch);
                RunMaintenanceIfDue(conn);
            }
        }
        finally
        {
            Drain(conn, cmd);
            _logger.LogInformation("批量写入已停止，累计写入 {Count} 条", WrittenCount);
        }
    }

    private async Task FillBatchAsync(List<EventRecord> batch, CancellationToken ct)
    {
        var max = _config.Current.Batch.MaxBatch;
        var deadline = Environment.TickCount64 + _config.Current.Batch.FlushIntervalMs;

        while (batch.Count < max)
        {
            while (batch.Count < max && _bus.Reader.TryRead(out var e))
            {
                batch.Add(e);
            }

            if (batch.Count >= max || Environment.TickCount64 >= deadline || ct.IsCancellationRequested)
            {
                return;
            }

            try
            {
                await Task.Delay(50, ct);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private void WriteBatch(SqliteConnection conn, SqliteCommand cmd, List<EventRecord> batch)
    {
        if (batch.Count == 0)
        {
            return;
        }

        try
        {
            Interlocked.Add(ref _written, EventInserter.InsertBatch(conn, cmd, batch));
            Interlocked.Exchange(ref _lastWriteAt, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "批量写入失败，重试一次（{Count} 条）", batch.Count);
            try
            {
                Thread.Sleep(200);
                Interlocked.Add(ref _written, EventInserter.InsertBatch(conn, cmd, batch));
                Interlocked.Exchange(ref _lastWriteAt, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            }
            catch (Exception retryEx)
            {
                Interlocked.Add(ref _writeErrors, batch.Count);
                _logger.LogError(retryEx, "批量写入重试失败，丢弃 {Count} 条", batch.Count);
            }
        }
    }

    private void Drain(SqliteConnection conn, SqliteCommand cmd)
    {
        var batch = new List<EventRecord>(_config.Current.Batch.MaxBatch);
        while (_bus.Reader.TryRead(out var e))
        {
            batch.Add(e);
            if (batch.Count >= _config.Current.Batch.MaxBatch)
            {
                WriteBatch(conn, cmd, batch);
                batch.Clear();
            }
        }

        WriteBatch(conn, cmd, batch);
    }

    private void RunMaintenanceIfDue(SqliteConnection conn)
    {
        var now = Environment.TickCount64;
        if (now - Interlocked.Read(ref _lastMaintenanceTicks) < MaintenanceInterval.TotalMilliseconds)
        {
            return;
        }

        Interlocked.Exchange(ref _lastMaintenanceTicks, now);
        try
        {
            RetentionRunner.Run(conn, _paths.DatabasePath, _config.Current, _logger);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "保留期清理失败");
        }
    }
}

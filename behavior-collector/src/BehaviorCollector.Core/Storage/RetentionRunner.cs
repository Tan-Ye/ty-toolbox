using BehaviorCollector.Core.Config;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace BehaviorCollector.Core.Storage;

/// <summary>
/// 保留期与容量清理：默认 90 天；库超过 2GB 时优先删最旧的 input.move。
/// 只在 BatchWriter 的写连接上执行，避免多写者锁冲突。
/// </summary>
public static class RetentionRunner
{
    public static void Run(SqliteConnection conn, string dbPath, CollectorConfig config, ILogger? logger = null)
    {
        var days = config.Storage.RetentionDays;
        var cutoff = DateTimeOffset.UtcNow.AddDays(-days).ToUnixTimeMilliseconds();

        var deleted = DeleteOlderThan(conn, cutoff);
        if (deleted > 0)
        {
            logger?.LogInformation("保留期清理：删除 {Count} 条 {Days} 天以前的事件", deleted, days);
            Vacuum(conn);
        }

        var maxBytes = config.Storage.MaxDbSizeMb * 1024L * 1024L;
        if (File.Exists(dbPath) && new FileInfo(dbPath).Length > maxBytes)
        {
            TrimForSize(conn, dbPath, maxBytes, logger);
        }
    }

    private static long DeleteOlderThan(SqliteConnection conn, long cutoff)
    {
        long total = 0;
        while (true)
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM events WHERE id IN " +
                              "(SELECT id FROM events WHERE ts < $cutoff LIMIT 5000);";
            cmd.Parameters.AddWithValue("$cutoff", cutoff);
            var rows = cmd.ExecuteNonQuery();
            total += rows;
            if (rows < 5000)
            {
                return total;
            }
        }
    }

    private static void TrimForSize(SqliteConnection conn, string dbPath, long maxBytes, ILogger? logger)
    {
        long total = 0;
        for (var i = 0; i < 200; i++)
        {
            if (new FileInfo(dbPath).Length <= maxBytes)
            {
                break;
            }

            using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM events WHERE id IN " +
                              "(SELECT id FROM events WHERE kind='input.move' ORDER BY id LIMIT 5000);";
            var rows = cmd.ExecuteNonQuery();
            total += rows;
            if (rows == 0)
            {
                break;
            }

            Vacuum(conn);
        }

        if (total > 0)
        {
            logger?.LogWarning("数据库超过 {MaxMb}MB，已删除最旧的 input.move {Count} 条", maxBytes / 1024 / 1024, total);
        }
    }

    private static void Vacuum(SqliteConnection conn)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA incremental_vacuum(2000);";
        cmd.ExecuteNonQuery();
    }
}

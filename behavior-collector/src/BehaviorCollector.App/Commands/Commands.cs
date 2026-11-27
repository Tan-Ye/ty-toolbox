using System.Globalization;
using System.Text.Json;
using BehaviorCollector.Core;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Diagnostics;
using BehaviorCollector.Core.Storage;
using BehaviorCollector.Core.Util;

namespace BehaviorCollector.App.Commands;

internal static class StatusCommand
{
    public static int Run(AppPaths paths, CollectorConfig config)
    {
        var snapshot = EventQuery.QueryStatus(paths.DatabasePath);
        var inputHook = InputHookStatusStore.Read(paths.InputHookStatusPath);
        var payload = new
        {
            running = SingleInstance.IsRunning(),
            paused = snapshot.Paused,
            dataDir = paths.DataDirectory,
            dbPath = paths.DatabasePath,
            dbSizeMb = Math.Round(snapshot.DbSizeBytes / 1024.0 / 1024.0, 2),
            retentionDays = config.Storage.RetentionDays,
            todayTotal = snapshot.TodayTotal,
            todayByKind = snapshot.TodayByKind,
            totalEvents = snapshot.TotalEvents,
            lastEventAt = snapshot.LastEventAt?.ToString("O"),
            inputHook = inputHook?.State ?? "unknown",
            inputHookMessage = inputHook?.Message,
            inputHookUpdatedAt = inputHook?.UpdatedAt.ToString("O"),
            inputHookEnabledAt = inputHook?.EnabledAt?.ToString("O"),
        };

        Console.WriteLine(JsonSerializer.Serialize(payload, JsonDefaults.Indented));
        return 0;
    }
}

internal static class ExportCommand
{
    public static int Run(string[] args, AppPaths paths)
    {
        var from = DateTime.Today;
        var toExclusive = from.AddDays(1);
        string? outputPath = null;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i].ToLowerInvariant())
            {
                case "--from":
                    if (i + 1 >= args.Length || !TryParseDate(args[++i], out from))
                    {
                        return Error("--from 需要 yyyy-MM-dd 格式的日期");
                    }

                    break;
                case "--to":
                    if (i + 1 >= args.Length || !TryParseDate(args[++i], out var toInclusive))
                    {
                        return Error("--to 需要 yyyy-MM-dd 格式的日期");
                    }

                    toExclusive = toInclusive.AddDays(1);
                    break;
                case "--out":
                    if (i + 1 >= args.Length)
                    {
                        return Error("--out 需要一个文件路径");
                    }

                    outputPath = args[++i];
                    break;
                case "--format":
                    if (i + 1 >= args.Length || !string.Equals(args[++i], "jsonl", StringComparison.OrdinalIgnoreCase))
                    {
                        return Error("当前只支持 --format jsonl");
                    }

                    break;
                default:
                    return Error($"未知参数：{args[i]}");
            }
        }

        if (toExclusive <= from)
        {
            return Error("--to 不能早于 --from");
        }

        var fromMs = new DateTimeOffset(from).ToUnixTimeMilliseconds();
        var toMs = new DateTimeOffset(toExclusive).ToUnixTimeMilliseconds();

        if (!File.Exists(paths.DatabasePath))
        {
            return Error($"数据库不存在：{paths.DatabasePath}");
        }

        if (outputPath is null)
        {
            using var stdout = Console.OpenStandardOutput();
            var count = EventQuery.ExportJsonl(paths.DatabasePath, fromMs, toMs, stdout);
            Console.Error.WriteLine($"已导出 {count} 条到 stdout");
            return 0;
        }

        var fullPath = Path.GetFullPath(outputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        using (var file = File.Create(fullPath))
        {
            var count = EventQuery.ExportJsonl(paths.DatabasePath, fromMs, toMs, file);
            Console.WriteLine($"已导出 {count} 条到 {fullPath}");
        }

        return 0;
    }

    private static bool TryParseDate(string value, out DateTime date)
    {
        return DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out date);
    }

    private static int Error(string message)
    {
        Console.Error.WriteLine(message);
        return 2;
    }
}

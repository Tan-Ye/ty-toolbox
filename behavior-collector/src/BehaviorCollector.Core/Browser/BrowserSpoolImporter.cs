using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Storage;
using Microsoft.Extensions.Logging;

namespace BehaviorCollector.Core.Browser;

/// <summary>
/// 主程序未运行时，Native Host 把浏览器事件写进 browser-spool.jsonl；
/// 主程序启动时先把缓冲写入 DB，成功后再删除文件。
/// </summary>
public static class BrowserSpoolImporter
{
    public static int Import(string dbPath, string spoolPath, int? session, ILogger? logger = null)
    {
        if (!File.Exists(spoolPath))
        {
            return 0;
        }

        var importing = spoolPath + ".importing";
        try
        {
            File.Move(spoolPath, importing, overwrite: true);
        }
        catch (IOException ex)
        {
            logger?.LogWarning(ex, "浏览器缓冲暂不可读，下次启动再导入");
            return 0;
        }

        var events = new List<EventRecord>();
        try
        {
            foreach (var line in File.ReadLines(importing))
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                var record = BrowserEventMapper.Map(line, session);
                if (record is not null)
                {
                    events.Add(record);
                }
            }

            if (events.Count > 0)
            {
                using var conn = Database.CreateConnection(dbPath);
                using var cmd = EventInserter.CreateInsertCommand(conn);
                EventInserter.InsertBatch(conn, cmd, events);
            }

            File.Delete(importing);
            logger?.LogInformation("浏览器缓冲导入完成：{Count} 条", events.Count);
            return events.Count;
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "浏览器缓冲导入失败，保留原文件");
            try
            {
                File.Move(importing, spoolPath, overwrite: true);
            }
            catch (IOException)
            {
            }

            return 0;
        }
    }
}

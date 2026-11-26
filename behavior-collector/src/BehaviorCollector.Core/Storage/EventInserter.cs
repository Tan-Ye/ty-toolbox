using BehaviorCollector.Core.Models;
using Microsoft.Data.Sqlite;

namespace BehaviorCollector.Core.Storage;

/// <summary>events 表的写入语句构造，供 BatchWriter 与浏览器缓冲导入复用。</summary>
public static class EventInserter
{
    public const string InsertSql = """
        INSERT INTO events(ts,kind,source,pid,hwnd,app,title,url,session,data,key_plain)
        VALUES($ts,$kind,$source,$pid,$hwnd,$app,$title,$url,$session,$data,$key_plain);
        """;

    public static SqliteCommand CreateInsertCommand(SqliteConnection conn)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = InsertSql;
        cmd.Parameters.Add("$ts", SqliteType.Integer);
        cmd.Parameters.Add("$kind", SqliteType.Text);
        cmd.Parameters.Add("$source", SqliteType.Text);
        cmd.Parameters.Add("$pid", SqliteType.Integer);
        cmd.Parameters.Add("$hwnd", SqliteType.Integer);
        cmd.Parameters.Add("$app", SqliteType.Text);
        cmd.Parameters.Add("$title", SqliteType.Text);
        cmd.Parameters.Add("$url", SqliteType.Text);
        cmd.Parameters.Add("$session", SqliteType.Integer);
        cmd.Parameters.Add("$data", SqliteType.Text);
        cmd.Parameters.Add("$key_plain", SqliteType.Text);
        cmd.Prepare();
        return cmd;
    }

    public static void Bind(SqliteCommand cmd, EventRecord e)
    {
        cmd.Parameters["$ts"].Value = e.Ts;
        cmd.Parameters["$kind"].Value = e.Kind;
        cmd.Parameters["$source"].Value = e.Source;
        cmd.Parameters["$pid"].Value = (object?)e.Pid ?? DBNull.Value;
        cmd.Parameters["$hwnd"].Value = (object?)e.Hwnd ?? DBNull.Value;
        cmd.Parameters["$app"].Value = (object?)e.App ?? DBNull.Value;
        cmd.Parameters["$title"].Value = (object?)e.Title ?? DBNull.Value;
        cmd.Parameters["$url"].Value = (object?)e.Url ?? DBNull.Value;
        cmd.Parameters["$session"].Value = (object?)e.Session ?? DBNull.Value;
        cmd.Parameters["$data"].Value = (object?)e.Data ?? DBNull.Value;
        cmd.Parameters["$key_plain"].Value = (object?)e.KeyPlain ?? DBNull.Value;
    }

    /// <summary>在一个事务里写入一批事件，返回写入条数。</summary>
    public static int InsertBatch(SqliteConnection conn, SqliteCommand cmd, IReadOnlyList<EventRecord> events)
    {
        if (events.Count == 0)
        {
            return 0;
        }

        using var tx = conn.BeginTransaction();
        cmd.Transaction = tx;
        foreach (var e in events)
        {
            Bind(cmd, e);
            cmd.ExecuteNonQuery();
        }

        tx.Commit();
        cmd.Transaction = null;
        return events.Count;
    }
}

using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace BehaviorCollector.Core.Storage;

public sealed record StatusSnapshot(
    int TodayTotal,
    IReadOnlyDictionary<string, int> TodayByKind,
    long TotalEvents,
    DateTimeOffset? LastEventAt,
    long DbSizeBytes,
    bool Paused);

/// <summary>只读查询：status 与 export。</summary>
public static class EventQuery
{
    public static StatusSnapshot QueryStatus(string dbPath, DateTimeOffset? now = null)
    {
        var todayStart = (now ?? DateTimeOffset.Now).LocalDateTime.Date;
        var fromMs = new DateTimeOffset(todayStart, TimeZoneInfo.Local.GetUtcOffset(todayStart))
            .ToUnixTimeMilliseconds();

        if (!File.Exists(dbPath))
        {
            return new StatusSnapshot(0, new Dictionary<string, int>(), 0, null, 0, false);
        }

        using var conn = Database.CreateConnection(dbPath, readOnly: true);
        var byKind = new Dictionary<string, int>();
        var todayTotal = 0;

        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT kind, COUNT(*) FROM events WHERE ts >= $from GROUP BY kind;";
            cmd.Parameters.AddWithValue("$from", fromMs);
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var kind = reader.GetString(0);
                var count = reader.GetInt32(1);
                byKind[kind] = count;
                todayTotal += count;
            }
        }

        long total;
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(*) FROM events;";
            total = Convert.ToInt64(cmd.ExecuteScalar());
        }

        DateTimeOffset? last = null;
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT MAX(ts) FROM events;";
            var value = cmd.ExecuteScalar();
            if (value is not null and not DBNull)
            {
                last = DateTimeOffset.FromUnixTimeMilliseconds(Convert.ToInt64(value));
            }
        }

        // 暂停状态：最近一条 pause.start / pause.end 即当前状态（跨进程可查）。
        var paused = false;
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText =
                "SELECT kind FROM events WHERE kind IN ('pause.start', 'pause.end') ORDER BY ts DESC, id DESC LIMIT 1;";
            var value = cmd.ExecuteScalar();
            paused = value is string kind && string.Equals(kind, "pause.start", StringComparison.Ordinal);
        }

        return new StatusSnapshot(todayTotal, byKind, total, last, new FileInfo(dbPath).Length, paused);
    }

    /// <summary>导出 [from, to) 的事件为 JSONL，返回条数。</summary>
    public static long ExportJsonl(string dbPath, long fromMs, long toMs, Stream output)
    {
        if (!File.Exists(dbPath))
        {
            return 0;
        }

        using var conn = Database.CreateConnection(dbPath, readOnly: true);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, ts, kind, source, pid, hwnd, app, title, url, session, data, key_plain
            FROM events WHERE ts >= $from AND ts < $to ORDER BY id;
            """;
        cmd.Parameters.AddWithValue("$from", fromMs);
        cmd.Parameters.AddWithValue("$to", toMs);

        using var reader = cmd.ExecuteReader();
        using var writer = new Utf8JsonWriter(output);
        long count = 0;

        while (reader.Read())
        {
            writer.WriteStartObject();
            writer.WriteNumber("id", reader.GetInt64(0));
            var ts = reader.GetInt64(1);
            writer.WriteNumber("ts", ts);
            writer.WriteString("ts_iso", DateTimeOffset.FromUnixTimeMilliseconds(ts).ToLocalTime().ToString("O"));
            writer.WriteString("kind", reader.GetString(2));
            writer.WriteString("source", reader.GetString(3));
            WriteNullableNumber(writer, "pid", reader, 4);
            WriteNullableNumber(writer, "hwnd", reader, 5);
            WriteNullableString(writer, "app", reader, 6);
            WriteNullableString(writer, "title", reader, 7);
            WriteNullableString(writer, "url", reader, 8);
            WriteNullableNumber(writer, "session", reader, 9);

            writer.WritePropertyName("data");
            if (reader.IsDBNull(10))
            {
                writer.WriteNullValue();
            }
            else
            {
                using var doc = JsonDocument.Parse(reader.GetString(10));
                doc.RootElement.WriteTo(writer);
            }

            WriteNullableString(writer, "key_plain", reader, 11);
            writer.WriteEndObject();
            writer.Flush();
            output.WriteByte((byte)'\n');
            writer.Reset(output);
            count++;
        }

        return count;
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, SqliteDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal))
        {
            writer.WriteNull(name);
        }
        else
        {
            writer.WriteString(name, reader.GetString(ordinal));
        }
    }

    private static void WriteNullableNumber(Utf8JsonWriter writer, string name, SqliteDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal))
        {
            writer.WriteNull(name);
        }
        else
        {
            writer.WriteNumber(name, reader.GetInt64(ordinal));
        }
    }
}

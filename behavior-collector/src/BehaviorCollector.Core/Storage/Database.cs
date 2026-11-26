using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace BehaviorCollector.Core.Storage;

/// <summary>
/// SQLite 初始化、schema 迁移与连接工厂。整个进程只有一个写连接（BatchWriter）。
/// </summary>
public static class Database
{
    public const int SchemaVersion = 1;

    public static void EnsureCreated(string dbPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
        using var conn = CreateConnection(dbPath);
        using var cmd = conn.CreateCommand();

        // auto_vacuum 必须在建表前设置；对已有库不生效，但不影响使用。
        cmd.CommandText = "PRAGMA auto_vacuum=INCREMENTAL;";
        cmd.ExecuteNonQuery();

        var version = Convert.ToInt64(Scalar(conn, "PRAGMA user_version;"));
        if (version < 1)
        {
            MigrateV1(conn);
        }

        if (version < SchemaVersion)
        {
            cmd.CommandText = $"PRAGMA user_version={SchemaVersion};";
            cmd.ExecuteNonQuery();
        }
    }

    public static SqliteConnection CreateConnection(string dbPath, bool readOnly = false)
    {
        var csb = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWriteCreate,
            Pooling = false,
            DefaultTimeout = 10,
        };

        var conn = new SqliteConnection(csb.ToString());
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA busy_timeout=10000;";
        cmd.ExecuteNonQuery();

        if (!readOnly)
        {
            cmd.CommandText = "PRAGMA journal_mode=WAL;";
            cmd.ExecuteNonQuery();
            cmd.CommandText = "PRAGMA synchronous=NORMAL;";
            cmd.ExecuteNonQuery();
        }

        return conn;
    }

    public static byte[] GetOrCreateSalt(string dbPath)
    {
        using var conn = CreateConnection(dbPath);
        var existing = GetMeta(conn, "install_salt");
        if (!string.IsNullOrEmpty(existing))
        {
            try
            {
                var bytes = Convert.FromHexString(existing);
                if (bytes.Length == 32)
                {
                    return bytes;
                }
            }
            catch (FormatException)
            {
                // 损坏的盐按不存在处理，重新生成。
            }
        }

        var salt = RandomNumberGenerator.GetBytes(32);
        SetMeta(conn, "install_salt", Convert.ToHexString(salt));
        SetMeta(conn, "install_id", Guid.NewGuid().ToString("N"));
        SetMeta(conn, "created_at", DateTimeOffset.UtcNow.ToString("O"));
        return salt;
    }

    public static string? GetMeta(SqliteConnection conn, string key)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT value FROM meta WHERE key=$key;";
        cmd.Parameters.AddWithValue("$key", key);
        return cmd.ExecuteScalar() as string;
    }

    public static void SetMeta(SqliteConnection conn, string key, string value)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT INTO meta(key,value) VALUES($key,$value) " +
                          "ON CONFLICT(key) DO UPDATE SET value=excluded.value;";
        cmd.Parameters.AddWithValue("$key", key);
        cmd.Parameters.AddWithValue("$value", value);
        cmd.ExecuteNonQuery();
    }

    private static void MigrateV1(SqliteConnection conn)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS events (
              id        INTEGER PRIMARY KEY AUTOINCREMENT,
              ts        INTEGER NOT NULL,
              kind      TEXT    NOT NULL,
              source    TEXT    NOT NULL,
              pid       INTEGER,
              hwnd      INTEGER,
              app       TEXT,
              title     TEXT,
              url       TEXT,
              session   INTEGER,
              data      TEXT,
              key_plain TEXT
            );

            CREATE INDEX IF NOT EXISTS ix_events_ts      ON events(ts);
            CREATE INDEX IF NOT EXISTS ix_events_kind_ts ON events(kind, ts);
            CREATE INDEX IF NOT EXISTS ix_events_app_ts  ON events(app, ts);

            CREATE TABLE IF NOT EXISTS meta (
              key   TEXT PRIMARY KEY,
              value TEXT
            );

            CREATE TABLE IF NOT EXISTS collector_state (
              source        TEXT PRIMARY KEY,
              enabled       INTEGER,
              last_error    TEXT,
              last_event_at INTEGER
            );
            """;
        cmd.ExecuteNonQuery();
    }

    private static object? Scalar(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }
}

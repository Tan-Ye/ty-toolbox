using System.Text;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Storage;

namespace BehaviorCollector.Tests;

public sealed class StorageTests : IDisposable
{
    private readonly string _dir;
    private readonly string _dbPath;

    public StorageTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "bc-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _dbPath = Path.Combine(_dir, "events.db");
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void EnsureCreated_CreatesSchemaAndStableSalt()
    {
        Database.EnsureCreated(_dbPath);
        var first = Database.GetOrCreateSalt(_dbPath);
        var second = Database.GetOrCreateSalt(_dbPath);

        Assert.Equal(32, first.Length);
        Assert.Equal(first, second);
    }

    [Fact]
    public void Insert_QueryAndExport_RoundTrip()
    {
        Database.EnsureCreated(_dbPath);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using (var conn = Database.CreateConnection(_dbPath))
        using (var cmd = EventInserter.CreateInsertCommand(conn))
        {
            EventInserter.InsertBatch(conn, cmd,
            [
                new EventRecord { Ts = now, Kind = "window.foreground", Source = "window", App = "test.exe", Title = "T", Session = 1, Data = """{"class":"X"}""" },
                new EventRecord { Ts = now, Kind = "input.key", Source = "input", App = "test.exe", Data = """{"vk_hash":"abc"}""", KeyPlain = null },
            ]);
        }

        var status = EventQuery.QueryStatus(_dbPath);
        Assert.Equal(2, status.TodayTotal);
        Assert.Equal(1, status.TodayByKind["window.foreground"]);
        Assert.Equal(2, status.TotalEvents);
        Assert.NotNull(status.LastEventAt);

        using var output = new MemoryStream();
        var exported = EventQuery.ExportJsonl(_dbPath, 0, long.MaxValue, output);
        Assert.Equal(2, exported);

        var jsonl = Encoding.UTF8.GetString(output.ToArray());
        var lines = jsonl.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(2, lines.Length);
        Assert.Contains("\"kind\":\"window.foreground\"", lines[0]);
        Assert.Contains("\"data\":{\"class\":\"X\"}", lines[0]);
    }

    [Fact]
    public void Retention_DeletesEventsOlderThanConfiguredDays()
    {
        Database.EnsureCreated(_dbPath);
        var old = DateTimeOffset.UtcNow.AddDays(-100).ToUnixTimeMilliseconds();
        var recent = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using (var conn = Database.CreateConnection(_dbPath))
        using (var cmd = EventInserter.CreateInsertCommand(conn))
        {
            EventInserter.InsertBatch(conn, cmd,
            [
                new EventRecord { Ts = old, Kind = "window.foreground", Source = "window" },
                new EventRecord { Ts = recent, Kind = "window.foreground", Source = "window" },
            ]);
        }

        using (var conn = Database.CreateConnection(_dbPath))
        {
            RetentionRunner.Run(conn, _dbPath, new CollectorConfig());
        }

        var status = EventQuery.QueryStatus(_dbPath);
        Assert.Equal(1, status.TotalEvents);
    }

    [Fact]
    public void Config_NormalizeClampsOutOfRangeValues()
    {
        var config = new CollectorConfig
        {
            Storage = new StorageConfig { RetentionDays = 0, MaxDbSizeMb = 1, DataDir = " " },
            Input = new InputConfig { MouseMoveHz = 1000, IdleThresholdSeconds = 1 },
            Batch = new BatchConfig { MaxBatch = 0, FlushIntervalMs = 1 },
            Privacy = new PrivacyConfig { ExcludedApps = null! },
            Autostart = new AutostartConfig { Mode = "whatever" },
        };

        config.Normalize();

        Assert.Equal(1, config.Storage.RetentionDays);
        Assert.Equal(100, config.Storage.MaxDbSizeMb);
        Assert.Equal("data", config.Storage.DataDir);
        Assert.Equal(60, config.Input.MouseMoveHz);
        Assert.Equal(10, config.Input.IdleThresholdSeconds);
        Assert.Equal(1, config.Batch.MaxBatch);
        Assert.Equal(100, config.Batch.FlushIntervalMs);
        Assert.NotNull(config.Privacy.ExcludedApps);
        Assert.Equal("ask", config.Autostart.Mode);
    }
}

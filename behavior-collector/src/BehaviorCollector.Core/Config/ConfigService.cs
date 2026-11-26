using System.Text.Json;
using BehaviorCollector.Core.Util;
using Microsoft.Extensions.Logging;

namespace BehaviorCollector.Core.Config;

/// <summary>
/// config.json 的加载、生成与热重载。文件改动后 300ms 防抖，解析失败保留旧配置。
/// </summary>
public sealed class ConfigService : IDisposable
{
    private readonly ILogger<ConfigService>? _logger;
    private readonly object _gate = new();
    private FileSystemWatcher? _watcher;
    private Timer? _debounce;
    private long _suppressReloadUntil;
    private CollectorConfig _current = new();

    public string ConfigPath { get; }

    public CollectorConfig Current => Volatile.Read(ref _current);

    public event Action<CollectorConfig>? Changed;

    public ConfigService(string configPath, ILogger<ConfigService>? logger = null)
    {
        ConfigPath = Path.GetFullPath(configPath);
        _logger = logger;
    }

    public CollectorConfig Load()
    {
        CollectorConfig config;
        if (File.Exists(ConfigPath))
        {
            try
            {
                var json = File.ReadAllText(ConfigPath);
                config = JsonSerializer.Deserialize<CollectorConfig>(json, JsonDefaults.Indented) ?? new CollectorConfig();
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "读取配置失败，使用默认配置：{Path}", ConfigPath);
                config = new CollectorConfig();
            }
        }
        else
        {
            config = new CollectorConfig();
            TryWriteDefault(config);
        }

        config.Normalize();
        Volatile.Write(ref _current, config);
        return config;
    }

    public void StartWatching()
    {
        if (_watcher is not null)
        {
            return;
        }

        var dir = Path.GetDirectoryName(ConfigPath)!;
        Directory.CreateDirectory(dir);
        _debounce = new Timer(_ => Reload(), null, Timeout.Infinite, Timeout.Infinite);
        _watcher = new FileSystemWatcher(dir, Path.GetFileName(ConfigPath))
        {
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
            EnableRaisingEvents = true,
        };
        _watcher.Changed += OnFileTouched;
        _watcher.Created += OnFileTouched;
        _watcher.Renamed += OnFileTouched;
    }

    private void OnFileTouched(object sender, FileSystemEventArgs e)
    {
        if (Environment.TickCount64 < Interlocked.Read(ref _suppressReloadUntil))
        {
            return;
        }

        try
        {
            _debounce?.Change(300, Timeout.Infinite);
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private void Reload()
    {
        lock (_gate)
        {
            try
            {
                if (!File.Exists(ConfigPath))
                {
                    return;
                }

                var json = File.ReadAllText(ConfigPath);
                var config = JsonSerializer.Deserialize<CollectorConfig>(json, JsonDefaults.Indented);
                if (config is null)
                {
                    return;
                }

                config.Normalize();
                Volatile.Write(ref _current, config);
                _logger?.LogInformation("配置已热重载");
                Changed?.Invoke(config);
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "配置热重载失败，继续使用旧配置");
            }
        }
    }

    public void Save(CollectorConfig config)
    {
        config.Normalize();
        lock (_gate)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
            var temp = ConfigPath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(config, JsonDefaults.Indented));
            File.Move(temp, ConfigPath, overwrite: true);
            Volatile.Write(ref _current, config);
            Interlocked.Exchange(ref _suppressReloadUntil, Environment.TickCount64 + 800);
        }
    }

    private void TryWriteDefault(CollectorConfig config)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
            File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config, JsonDefaults.Indented));
            _logger?.LogInformation("已生成默认配置：{Path}", ConfigPath);
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "生成默认配置失败：{Path}", ConfigPath);
        }
    }

    public void Dispose()
    {
        if (_watcher is not null)
        {
            _watcher.EnableRaisingEvents = false;
            _watcher.Changed -= OnFileTouched;
            _watcher.Created -= OnFileTouched;
            _watcher.Renamed -= OnFileTouched;
            _watcher.Dispose();
            _watcher = null;
        }

        _debounce?.Dispose();
        _debounce = null;
    }
}

namespace BehaviorCollector.Core.Config;

/// <summary>
/// config.json 的强类型模型。所有字段都有可运行默认值，文件缺失时自动生成。
/// </summary>
public sealed class CollectorConfig
{
    public StorageConfig Storage { get; set; } = new();
    public CollectorsConfig Collectors { get; set; } = new();
    public InputConfig Input { get; set; } = new();
    public PrivacyConfig Privacy { get; set; } = new();
    public BatchConfig Batch { get; set; } = new();
    public HotkeyConfig Hotkey { get; set; } = new();
    public AutostartConfig Autostart { get; set; } = new();

    public void Normalize()
    {
        Storage ??= new StorageConfig();
        Collectors ??= new CollectorsConfig();
        Input ??= new InputConfig();
        Privacy ??= new PrivacyConfig();
        Batch ??= new BatchConfig();
        Hotkey ??= new HotkeyConfig();
        Autostart ??= new AutostartConfig();

        Storage.RetentionDays = Math.Clamp(Storage.RetentionDays, 1, 3650);
        Storage.MaxDbSizeMb = Math.Clamp(Storage.MaxDbSizeMb, 100, 102_400);
        if (string.IsNullOrWhiteSpace(Storage.DataDir))
        {
            Storage.DataDir = "data";
        }

        Input.MouseMoveHz = Math.Clamp(Input.MouseMoveHz, 1, 60);
        Input.IdleThresholdSeconds = Math.Clamp(Input.IdleThresholdSeconds, 10, 3600);

        Batch.MaxBatch = Math.Clamp(Batch.MaxBatch, 1, 10_000);
        Batch.FlushIntervalMs = Math.Clamp(Batch.FlushIntervalMs, 100, 10_000);

        Privacy.ExcludedApps ??= new List<string>();
        if (string.IsNullOrWhiteSpace(Hotkey.TogglePause))
        {
            Hotkey.TogglePause = "Ctrl+Alt+P";
        }

        Autostart.Mode = (Autostart.Mode ?? "ask").Trim().ToLowerInvariant();
        if (Autostart.Mode is not ("ask" or "enabled" or "disabled"))
        {
            Autostart.Mode = "ask";
        }
    }
}

public sealed class StorageConfig
{
    /// <summary>相对项目根目录，或绝对路径。默认放在 behavior-collector/data。</summary>
    public string DataDir { get; set; } = "data";
    public int RetentionDays { get; set; } = 90;
    public int MaxDbSizeMb { get; set; } = 2048;
}

public sealed class CollectorsConfig
{
    public bool Window { get; set; } = true;

    /// <summary>进程启停采集。默认关：日报和区间回放用 app.start/stop + 前台窗口就够，进程级事件约占总量 23% 且信息与 app 级重复。</summary>
    public bool Process { get; set; } = false;
    public bool Input { get; set; } = true;
    public bool Browser { get; set; } = true;
}

public sealed class InputConfig
{
    /// <summary>鼠标移动降采样频率上限。仅在 CollectMouseMove=true 时生效。</summary>
    public int MouseMoveHz { get; set; } = 20;

    /// <summary>是否采集鼠标移动轨迹。默认关：日报和区间回放用不上逐条移动，逐条移动占事件量约 25%。</summary>
    public bool CollectMouseMove { get; set; } = false;

    /// <summary>是否采集逐键事件（按键只存不可逆 HMAC）。默认关：需要的是输入密度而不是按键轨迹，逐键事件也会扩大全局钩子的暴露面。</summary>
    public bool CollectKeys { get; set; } = false;

    public int IdleThresholdSeconds { get; set; } = 60;
}

public sealed class PrivacyConfig
{
    /// <summary>明文按键默认关；打开后仍需托盘二次确认。</summary>
    public bool PlaintextKeys { get; set; }

    public List<string> ExcludedApps { get; set; } =
    [
        "*password*",
        "keepass*",
        "1password*",
        "bitwarden*",
        "*bank*",
    ];
}

public sealed class BatchConfig
{
    public int MaxBatch { get; set; } = 500;
    public int FlushIntervalMs { get; set; } = 1000;
}

public sealed class HotkeyConfig
{
    public string TogglePause { get; set; } = "Ctrl+Alt+P";
}

public sealed class AutostartConfig
{
    /// <summary>ask | enabled | disabled。</summary>
    public string Mode { get; set; } = "ask";
}

namespace BehaviorCollector.Core;

/// <summary>
/// 运行时路径。数据默认放项目内 behavior-collector/data，绝不写 C 盘用户目录。
/// </summary>
public sealed class AppPaths
{
    public string RootDirectory { get; }
    public string DataDirectory { get; }
    public string ConfigPath => Path.Combine(RootDirectory, "config.json");
    public string DatabasePath => Path.Combine(DataDirectory, "events.db");
    public string LogDirectory => Path.Combine(DataDirectory, "logs");
    public string NativeHostDirectory => Path.Combine(DataDirectory, "native-host");
    public string BrowserSpoolPath => Path.Combine(DataDirectory, "browser-spool.jsonl");
    public string InputHookStatusPath => Path.Combine(DataDirectory, "input-hook-status.json");

    public AppPaths(string rootDirectory, string dataDirectory)
    {
        RootDirectory = Path.GetFullPath(rootDirectory);
        DataDirectory = Path.GetFullPath(dataDirectory);
    }

    public static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 10 && dir is not null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "BehaviorCollector.slnx")))
            {
                return dir.FullName;
            }
        }

        // 发布后没有 slnx，数据放到 exe 同目录的 data/。
        return AppContext.BaseDirectory;
    }

    public static AppPaths Create(string root, string configuredDataDir)
    {
        var dataDir = Path.IsPathRooted(configuredDataDir)
            ? configuredDataDir
            : Path.Combine(root, configuredDataDir);
        return new AppPaths(root, dataDir);
    }

    public void EnsureDirectories()
    {
        Directory.CreateDirectory(DataDirectory);
        Directory.CreateDirectory(LogDirectory);
        Directory.CreateDirectory(NativeHostDirectory);
    }
}

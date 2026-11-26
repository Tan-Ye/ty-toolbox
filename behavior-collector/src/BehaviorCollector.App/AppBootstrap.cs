using System.Reflection;
using BehaviorCollector.Core;
using BehaviorCollector.Core.Config;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Extensions.Logging;

namespace BehaviorCollector.App;

internal static class AppBootstrap
{
    public const string Version = "0.1.0";

    public static (AppPaths Paths, ConfigService Config) LoadConfiguration(bool withWatcher)
    {
        var root = AppPaths.FindRoot();
        using var bootstrap = new ConfigService(Path.Combine(root, "config.json"));
        bootstrap.Load();

        var paths = AppPaths.Create(root, bootstrap.Current.Storage.DataDir);
        paths.EnsureDirectories();

        var config = new ConfigService(paths.ConfigPath);
        config.Load();
        if (withWatcher)
        {
            config.StartWatching();
        }

        return (paths, config);
    }

    public static void ConfigureLogging(AppPaths paths)
    {
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Information()
            .WriteTo.File(
                Path.Combine(paths.LogDirectory, "collector-.log"),
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 7,
                shared: true,
                outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff} [{Level:u3}] {Message:lj}{NewLine}{Exception}")
            .CreateLogger();
    }

    public static ILoggerFactory CreateLoggerFactory()
    {
        return LoggerFactory.Create(builder => builder.AddSerilog(Log.Logger, dispose: false));
    }

    /// <summary>写入 HKCU Run 的完整启动命令（含引号与参数）。</summary>
    public static string LaunchCommand()
    {
        var processPath = Environment.ProcessPath;
        var entryAssembly = Assembly.GetEntryAssembly()?.Location;

        // 通过 dotnet 宿主运行时必须带上入口 dll，否则自启只会启动 dotnet 本身。
        if (!string.IsNullOrEmpty(processPath) &&
            Path.GetFileNameWithoutExtension(processPath).Equals("dotnet", StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrEmpty(entryAssembly))
        {
            return $"\"{processPath}\" \"{entryAssembly}\"";
        }

        if (!string.IsNullOrEmpty(processPath))
        {
            return $"\"{processPath}\"";
        }

        return $"\"{Path.Combine(AppContext.BaseDirectory, "BehaviorCollector.exe")}\"";
    }

    /// <summary>Native Messaging 宿主的可执行文件路径：manifest 的 path 不支持参数，固定用 apphost。</summary>
    public static string HostExecutablePath()
    {
        var appHost = Path.Combine(AppContext.BaseDirectory, "BehaviorCollector.exe");
        return File.Exists(appHost) ? appHost : Environment.ProcessPath ?? appHost;
    }
}

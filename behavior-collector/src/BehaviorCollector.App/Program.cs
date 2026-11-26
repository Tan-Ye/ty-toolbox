using System.Text.Json;
using System.Windows.Forms;
using BehaviorCollector.App.Commands;
using BehaviorCollector.Collectors;
using BehaviorCollector.Collectors.Browser;
using BehaviorCollector.Collectors.Privacy;
using BehaviorCollector.Core;
using BehaviorCollector.Core.Browser;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Diagnostics;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Privacy;
using BehaviorCollector.Core.Storage;
using BehaviorCollector.Core.Util;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Serilog;
using ILogger = Microsoft.Extensions.Logging.ILogger;

namespace BehaviorCollector.App;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        if (IsBrowserHost(args))
        {
            return RunBrowserHost();
        }

        var mode = args.FirstOrDefault()?.ToLowerInvariant();
        if (mode is "--status" or "export" or "--export" or "--quit" or "--help" or "-h")
        {
            ConsoleBootstrap.AttachToParent();
            if (mode is "--help" or "-h")
            {
                PrintHelp();
                return 0;
            }

            if (mode is "--quit")
            {
                return QuitRunningInstance();
            }

            var (paths, config) = AppBootstrap.LoadConfiguration(withWatcher: false);
            using (config)
            {
                return mode switch
                {
                    "--status" => StatusCommand.Run(paths, config.Current),
                    "export" or "--export" => ExportCommand.Run(args.Skip(1).ToArray(), paths),
                    _ => 1,
                };
            }
        }

        return RunTray();
    }

    private static bool IsBrowserHost(string[] args)
    {
        if (args.Any(a => string.Equals(a, "--browser-host", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        return args.Length > 0 &&
               args[0].StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase);
    }

    private static int RunBrowserHost()
    {
        var (paths, config) = AppBootstrap.LoadConfiguration(withWatcher: false);
        using (config)
        {
            return BrowserHostRunner.RunAsync(paths, CancellationToken.None).GetAwaiter().GetResult();
        }
    }

    private static int RunTray()
    {
        using var instance = new SingleInstance();
        if (!instance.IsOwner)
        {
            MessageBox.Show("BehaviorCollector 已在运行，请查看系统托盘。", "BehaviorCollector",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        var root = AppPaths.FindRoot();
        using var bootstrap = new ConfigService(Path.Combine(root, "config.json"));
        bootstrap.Load();
        var paths = AppPaths.Create(root, bootstrap.Current.Storage.DataDir);
        paths.EnsureDirectories();
        AppBootstrap.ConfigureLogging(paths);

        using var loggerFactory = AppBootstrap.CreateLoggerFactory();
        var logger = loggerFactory.CreateLogger("BehaviorCollector");
        using var config = new ConfigService(paths.ConfigPath, loggerFactory.CreateLogger<ConfigService>());
        config.Load();
        config.StartWatching();

        try
        {
            return RunTrayCore(paths, config, loggerFactory, logger);
        }
        catch (Exception ex)
        {
            logger.LogCritical(ex, "BehaviorCollector 启动失败");
            MessageBox.Show($"BehaviorCollector 启动失败：\n{ex.Message}\n\n详见 {paths.LogDirectory}", "BehaviorCollector",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            Log.CloseAndFlush();
        }
    }

    private static int RunTrayCore(AppPaths paths, ConfigService config, ILoggerFactory loggerFactory, ILogger logger)
    {
        var launchCommand = AppBootstrap.LaunchCommand();
        Database.EnsureCreated(paths.DatabasePath);
        var salt = Database.GetOrCreateSalt(paths.DatabasePath);

        var bus = new EventBus();
        var pause = new PauseState();
        var plaintext = new PlaintextPolicy();
        ConfirmPlaintextAtStartup(config.Current, plaintext, logger);
        ConfirmAutostart(config, launchCommand, logger);
        NativeHostRegistration.Register(paths, AppBootstrap.HostExecutablePath(), msg => logger.LogInformation("{Message}", msg));
        BrowserSpoolImporter.Import(paths.DatabasePath, paths.BrowserSpoolPath, SessionInfo.Current,
            loggerFactory.CreateLogger(typeof(BrowserSpoolImporter)));

        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
        {
            Args = Array.Empty<string>(),
            DisableDefaults = true,
        });
        builder.Logging.ClearProviders();
        builder.Logging.AddSerilog(Log.Logger, dispose: false);
        builder.Logging.AddFilter("Microsoft.Hosting.Lifetime", LogLevel.Warning);
        builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(10));
        builder.Services.AddSingleton(paths);
        builder.Services.AddSingleton(config);
        builder.Services.AddSingleton(new InputHookStatusStore(paths.InputHookStatusPath));
        builder.Services.AddSingleton(bus);
        builder.Services.AddSingleton(pause);
        builder.Services.AddSingleton(plaintext);
        builder.Services.AddSingleton(new KeyHasher(salt));
        builder.Services.AddSingleton<ForegroundState>();
        builder.Services.AddSingleton<PrivacyPolicy>();
        builder.Services.AddSingleton<IdleDetector>();
        builder.Services.AddSingleton<BatchWriter>();
        builder.Services.AddSingleton<WindowCollector>();
        builder.Services.AddSingleton<ProcessCollector>();
        builder.Services.AddSingleton<InputCollector>();
        builder.Services.AddSingleton<BrowserPipeServer>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<BatchWriter>());
        builder.Services.AddHostedService(sp => sp.GetRequiredService<WindowCollector>());
        builder.Services.AddHostedService(sp => sp.GetRequiredService<ProcessCollector>());
        builder.Services.AddHostedService(sp => sp.GetRequiredService<IdleDetector>());
        builder.Services.AddHostedService(sp => sp.GetRequiredService<InputCollector>());
        builder.Services.AddHostedService(sp => sp.GetRequiredService<BrowserPipeServer>());

        using var host = builder.Build();
        var writer = host.Services.GetRequiredService<BatchWriter>();
        using var hotkey = new GlobalHotkey();
        var plaintextConfigLast = config.Current.Privacy.PlaintextKeys;

        config.Changed += updated =>
        {
            if (updated.Privacy.PlaintextKeys != plaintextConfigLast)
            {
                plaintextConfigLast = updated.Privacy.PlaintextKeys;
                ConfirmPlaintextOnChange(updated, plaintext, logger);
            }

            Autostart.Apply(updated.Autostart, launchCommand, msg => logger.LogInformation("{Message}", msg));
            if (!hotkey.TryRegister(updated.Hotkey.TogglePause, out var error))
            {
                logger.LogWarning("{Error}", error);
            }
        };

        pause.Changed += paused =>
        {
            bus.Emit(new EventRecord
            {
                Kind = paused ? "pause.start" : "pause.end",
                Source = "app",
                Session = SessionInfo.Current,
                Data = JsonSerializer.Serialize(new { paused }, JsonDefaults.Compact),
            });
            logger.LogInformation(paused ? "采集已暂停" : "采集已恢复");
        };

        bus.Emit(new EventRecord
        {
            Kind = "app.start",
            Source = "app",
            Session = SessionInfo.Current,
            Data = JsonSerializer.Serialize(new
            {
                version = AppBootstrap.Version,
                pid = Environment.ProcessId,
                os = Environment.OSVersion.VersionString,
            }, JsonDefaults.Compact),
        });

        try
        {
            host.StartAsync().GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            logger.LogCritical(ex, "采集服务启动失败");
            MessageBox.Show($"采集服务启动失败：\n{ex.Message}", "BehaviorCollector",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        if (!hotkey.TryRegister(config.Current.Hotkey.TogglePause, out var hotkeyError))
        {
            logger.LogWarning("{Error}", hotkeyError);
        }

        hotkey.Pressed += () => pause.Toggle();
        logger.LogInformation("BehaviorCollector 已启动，数据目录 {DataDir}", paths.DataDirectory);

        void OnExit()
        {
            bus.Emit(new EventRecord
            {
                Kind = "app.stop",
                Source = "app",
                Session = SessionInfo.Current,
                Data = JsonSerializer.Serialize(new { reason = "exit" }, JsonDefaults.Compact),
            });
            bus.Complete();
            try
            {
                host.StopAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "停止采集服务时出错");
            }
        }

        var context = new TrayApplicationContext(bus, pause, writer, paths,
            loggerFactory.CreateLogger<TrayApplicationContext>(), OnExit);
        try
        {
            Application.Run(context);
        }
        finally
        {
            context.Dispose();
        }

        logger.LogInformation("BehaviorCollector 已退出");
        return 0;
    }

    private static void ConfirmPlaintextAtStartup(CollectorConfig cfg, PlaintextPolicy policy, ILogger logger)
    {
        if (!cfg.Privacy.PlaintextKeys)
        {
            policy.Enabled = false;
            return;
        }

        var result = MessageBox.Show(
            "config.json 已开启明文按键记录。\n\n这会把按键名称明文写入本机数据库（仅本机，不上传）。是否本次运行启用？",
            "BehaviorCollector · 隐私确认",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        policy.Enabled = result == DialogResult.Yes;
        if (policy.Enabled)
        {
            logger.LogWarning("明文按键记录已按用户确认开启");
        }
        else
        {
            logger.LogInformation("用户拒绝明文按键，本次运行仍只存哈希");
        }
    }

    private static void ConfirmPlaintextOnChange(CollectorConfig cfg, PlaintextPolicy policy, ILogger logger)
    {
        if (!cfg.Privacy.PlaintextKeys)
        {
            policy.Enabled = false;
            logger.LogInformation("明文按键记录已关闭");
            return;
        }

        var result = MessageBox.Show(
            "config.json 已改为开启明文按键记录。\n\n是否本次运行启用明文按键？",
            "BehaviorCollector · 隐私确认",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        policy.Enabled = result == DialogResult.Yes;
        logger.LogWarning(policy.Enabled ? "明文按键记录已开启" : "用户拒绝明文按键");
    }

    private static void ConfirmAutostart(ConfigService config, string launchCommand, ILogger logger)
    {
        var cfg = config.Current;
        if (cfg.Autostart.Mode == "ask")
        {
            var result = MessageBox.Show(
                "是否让 BehaviorCollector 在开机时自动启动？\n\n以后可在 config.json 的 autostart.mode 中修改。",
                "BehaviorCollector",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            cfg.Autostart.Mode = result == DialogResult.Yes ? "enabled" : "disabled";
            config.Save(cfg);
        }

        Autostart.Apply(cfg.Autostart, launchCommand, msg => logger.LogInformation("{Message}", msg));
    }

    private static int QuitRunningInstance()
    {
        try
        {
            using var quit = EventWaitHandle.OpenExisting(TrayApplicationContext.QuitEventName);
            quit.Set();
            Console.WriteLine("已通知 BehaviorCollector 退出");
            return 0;
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            Console.Error.WriteLine("BehaviorCollector 未在运行");
            return 1;
        }
        catch (UnauthorizedAccessException)
        {
            Console.Error.WriteLine("无权通知 BehaviorCollector 退出");
            return 1;
        }
    }

    private static void PrintHelp()
    {
        Console.WriteLine($"""
            BehaviorCollector {AppBootstrap.Version}

            用法：
              BehaviorCollector                          启动托盘采集
              BehaviorCollector --status                 输出今日/累计统计 JSON
              BehaviorCollector export --from 2026-11-01 --to 2026-11-26 [--out events.jsonl]
              BehaviorCollector --quit                   通知正在运行的实例退出
              BehaviorCollector --browser-host           Native Messaging 模式（由 Chrome 自动调用）

            数据目录：默认 behavior-collector/data（可用 config.json 的 storage.dataDir 修改）
            """);
    }
}

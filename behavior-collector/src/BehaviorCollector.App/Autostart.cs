using BehaviorCollector.Core.Config;
using Microsoft.Win32;

namespace BehaviorCollector.App;

/// <summary>开机自启：HKCU Run，不需要管理员权限。</summary>
internal static class Autostart
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "BehaviorCollector";

    /// <param name="launchCommand">完整启动命令，已包含引号与参数。</param>
    public static void Apply(AutostartConfig config, string launchCommand, Action<string>? log = null)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true)
                            ?? Registry.CurrentUser.CreateSubKey(RunKeyPath);
            if (key is null)
            {
                return;
            }

            switch (config.Mode)
            {
                case "enabled":
                    if (!string.Equals(key.GetValue(ValueName) as string, launchCommand, StringComparison.OrdinalIgnoreCase))
                    {
                        key.SetValue(ValueName, launchCommand);
                        log?.Invoke("已开启开机自启");
                    }

                    break;
                case "disabled":
                    if (key.GetValue(ValueName) is not null)
                    {
                        key.DeleteValue(ValueName, throwOnMissingValue: false);
                        log?.Invoke("已关闭开机自启");
                    }

                    break;
            }
        }
        catch (Exception ex)
        {
            log?.Invoke($"设置开机自启失败：{ex.Message}");
        }
    }
}

using System.Text.Json;
using BehaviorCollector.Core;
using BehaviorCollector.Core.Browser;
using BehaviorCollector.Core.Util;
using Microsoft.Win32;

namespace BehaviorCollector.App;

/// <summary>
/// 写入 Chrome Native Messaging host 清单，并在 HKCU 注册。
/// 扩展 ID 由 manifest.json 里的固定 key 决定，二者必须同步。
/// </summary>
internal static class NativeHostRegistration
{
    private const string ChromeRegistryPath = @"Software\Google\Chrome\NativeMessagingHosts\";

    public static string Register(AppPaths paths, string executablePath, Action<string>? log = null)
    {
        var manifestPath = Path.Combine(paths.NativeHostDirectory, BrowserConstants.NativeHostName + ".json");
        var manifest = new
        {
            name = BrowserConstants.NativeHostName,
            description = "BehaviorCollector 浏览器行为采集宿主",
            path = executablePath,
            type = "stdio",
            allowed_origins = new[] { $"chrome-extension://{BrowserConstants.ExtensionId}/" },
        };

        Directory.CreateDirectory(paths.NativeHostDirectory);
        File.WriteAllText(manifestPath, JsonSerializer.Serialize(manifest, JsonDefaults.Indented));

        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(ChromeRegistryPath + BrowserConstants.NativeHostName);
            key?.SetValue(string.Empty, manifestPath);
            log?.Invoke("Chrome Native Messaging 宿主已注册");
        }
        catch (Exception ex)
        {
            log?.Invoke($"注册 Chrome Native Messaging 宿主失败：{ex.Message}");
        }

        return manifestPath;
    }
}

using System.Diagnostics;
using System.Runtime.InteropServices;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Graphics.Gdi;
using Windows.Win32.System.Diagnostics.ToolHelp;
using Windows.Win32.System.Threading;

namespace BehaviorCollector.Collectors.Win32;

internal sealed record WindowSnapshot(
    IntPtr Hwnd,
    int Pid,
    string App,
    string Title,
    string ClassName,
    int Left,
    int Top,
    int Right,
    int Bottom,
    IntPtr Monitor,
    bool MonitorPrimary,
    bool IsFullscreen)
{
    public long BoundsWidth => Math.Max(0, Right - Left);
    public long BoundsHeight => Math.Max(0, Bottom - Top);
}

internal static class Win32Util
{
    public const uint EVENT_SYSTEM_FOREGROUND = 3;
    public const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
    public const uint WINEVENT_OUTOFCONTEXT = 0;
    public const uint WM_QUIT = 0x0012;
    public const uint MONITORINFOF_PRIMARY = 1;

    public static int CurrentSessionId
    {
        get
        {
            var id = PInvoke.WTSGetActiveConsoleSessionId();
            return id == uint.MaxValue ? -1 : (int)id;
        }
    }

    public static WindowSnapshot? TryGetForegroundWindow() => TryGetWindow((IntPtr)PInvoke.GetForegroundWindow());

    public static WindowSnapshot? TryGetWindowFromPoint(int x, int y)
    {
        var hwnd = PInvoke.WindowFromPoint(new System.Drawing.Point(x, y));
        return TryGetWindow((IntPtr)hwnd);
    }

    public static IntPtr HwndFromPoint(int x, int y) => (IntPtr)PInvoke.WindowFromPoint(new System.Drawing.Point(x, y));

    public static WindowSnapshot? TryGetWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            var win32Hwnd = (HWND)hwnd;
            PInvoke.GetWindowThreadProcessId(win32Hwnd, out var pid);

            Span<char> titleBuffer = stackalloc char[512];
            var titleLength = PInvoke.GetWindowText(win32Hwnd, titleBuffer);
            var title = titleLength > 0 ? titleBuffer[..titleLength].ToString() : string.Empty;

            Span<char> classBuffer = stackalloc char[256];
            var classLength = PInvoke.GetClassName(win32Hwnd, classBuffer);
            var className = classLength > 0 ? classBuffer[..classLength].ToString() : string.Empty;

            var rect = default(RECT);
            PInvoke.GetWindowRect(win32Hwnd, out rect);

            var monitor = PInvoke.MonitorFromWindow(win32Hwnd, MONITOR_FROM_FLAGS.MONITOR_DEFAULTTONEAREST);
            var monitorInfo = new MONITORINFO { cbSize = (uint)Marshal.SizeOf<MONITORINFO>() };
            var hasMonitor = !monitor.IsNull && PInvoke.GetMonitorInfo(monitor, ref monitorInfo);
            var monitorPrimary = hasMonitor && (monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
            var isFullscreen = hasMonitor &&
                               rect.left <= monitorInfo.rcMonitor.left + 2 &&
                               rect.top <= monitorInfo.rcMonitor.top + 2 &&
                               rect.right >= monitorInfo.rcMonitor.right - 2 &&
                               rect.bottom >= monitorInfo.rcMonitor.bottom - 2;

            var app = GetAppName((int)pid) ?? "unknown.exe";

            return new WindowSnapshot(
                hwnd,
                (int)pid,
                app,
                title,
                className,
                rect.left,
                rect.top,
                rect.right,
                rect.bottom,
                (IntPtr)monitor,
                monitorPrimary,
                isFullscreen);
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static string? GetAppName(int pid)
    {
        var path = GetProcessPath(pid);
        if (!string.IsNullOrEmpty(path))
        {
            return Path.GetFileName(path).ToLowerInvariant();
        }

        try
        {
            using var process = Process.GetProcessById(pid);
            return (process.ProcessName + ".exe").ToLowerInvariant();
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static string? GetProcessPath(int pid)
    {
        try
        {
            using var handle = PInvoke.OpenProcess_SafeHandle(
                PROCESS_ACCESS_RIGHTS.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
            if (handle.IsInvalid)
            {
                return null;
            }

            Span<char> buffer = stackalloc char[1024];
            uint size = (uint)buffer.Length;
            return PInvoke.QueryFullProcessImageName(
                handle, PROCESS_NAME_FORMAT.PROCESS_NAME_WIN32, buffer, ref size)
                ? buffer[..(int)size].ToString()
                : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static IReadOnlyList<ProcessSnapshot> EnumerateProcesses()
    {
        var result = new List<ProcessSnapshot>(256);
        using var snapshot = PInvoke.CreateToolhelp32Snapshot_SafeHandle(
            CREATE_TOOLHELP_SNAPSHOT_FLAGS.TH32CS_SNAPPROCESS, 0);
        if (snapshot.IsInvalid)
        {
            return result;
        }

        var entry = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
        if (!PInvoke.Process32FirstW(snapshot, ref entry))
        {
            return result;
        }

        do
        {
            result.Add(new ProcessSnapshot(
                (int)entry.th32ProcessID,
                (int)entry.th32ParentProcessID,
                entry.szExeFile.ToString()));
        }
        while (PInvoke.Process32NextW(snapshot, ref entry));

        return result;
    }
}

internal readonly record struct ProcessSnapshot(int Pid, int ParentPid, string ExeName);

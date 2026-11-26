using System.Runtime.InteropServices;
using System.Text;

namespace BehaviorCollector.App;

/// <summary>WinExe 启动的 CLI 模式需要附到父控制台，否则输出会丢失。</summary>
internal static class ConsoleBootstrap
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    public static void AttachToParent()
    {
        // 输出已被调用方重定向（管道/文件）时保持原句柄，不要把 stdout 抢到新控制台。
        if (Console.IsOutputRedirected)
        {
            return;
        }

        if (!AttachConsole(-1) && !AllocConsole())
        {
            return;
        }

        var encoding = new UTF8Encoding(false);
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), encoding) { AutoFlush = true });
        Console.SetError(new StreamWriter(Console.OpenStandardError(), encoding) { AutoFlush = true });
        try
        {
            Console.OutputEncoding = encoding;
        }
        catch (IOException)
        {
        }
    }
}

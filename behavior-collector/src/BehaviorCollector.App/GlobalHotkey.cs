using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace BehaviorCollector.App;

/// <summary>全局暂停热键（默认 Ctrl+Alt+P）。hWnd 为空时 WM_HOTKEY 投递到线程消息队列。</summary>
internal sealed class GlobalHotkey : IMessageFilter, IDisposable
{
    private const int HotkeyId = 0x4BC0;
    private const int WmHotkey = 0x0312;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModShift = 0x0004;
    private const uint ModWin = 0x0008;
    private const uint ModNoRepeat = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private bool _registered;

    public event Action? Pressed;

    public bool TryRegister(string specification, out string? error)
    {
        Unregister();
        if (!TryParse(specification, out var modifiers, out var vk))
        {
            error = $"无法解析热键：{specification}";
            return false;
        }

        if (!RegisterHotKey(IntPtr.Zero, HotkeyId, modifiers | ModNoRepeat, vk))
        {
            error = $"热键 {specification} 注册失败（可能被其它程序占用）";
            return false;
        }

        _registered = true;
        Application.AddMessageFilter(this);
        error = null;
        return true;
    }

    public bool PreFilterMessage(ref Message m)
    {
        if (m.Msg == WmHotkey && m.WParam.ToInt32() == HotkeyId)
        {
            Pressed?.Invoke();
            return true;
        }

        return false;
    }

    private void Unregister()
    {
        if (!_registered)
        {
            return;
        }

        UnregisterHotKey(IntPtr.Zero, HotkeyId);
        Application.RemoveMessageFilter(this);
        _registered = false;
    }

    private static bool TryParse(string specification, out uint modifiers, out uint virtualKey)
    {
        modifiers = 0;
        virtualKey = 0;
        var parts = specification.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0)
        {
            return false;
        }

        for (var i = 0; i < parts.Length; i++)
        {
            var part = parts[i].Trim();
            var isLast = i == parts.Length - 1;
            if (!isLast)
            {
                switch (part.ToLowerInvariant())
                {
                    case "ctrl":
                    case "control":
                        modifiers |= ModControl;
                        break;
                    case "alt":
                        modifiers |= ModAlt;
                        break;
                    case "shift":
                        modifiers |= ModShift;
                        break;
                    case "win":
                    case "meta":
                        modifiers |= ModWin;
                        break;
                    default:
                        return false;
                }

                continue;
            }

            virtualKey = ParseKey(part);
        }

        return virtualKey != 0;
    }

    private static uint ParseKey(string key)
    {
        if (key.Length == 1)
        {
            var c = char.ToUpperInvariant(key[0]);
            if (c is >= 'A' and <= 'Z' or >= '0' and <= '9')
            {
                return c;
            }
        }

        if (key.Length is 2 or 3 && key[0] is 'F' or 'f' && int.TryParse(key[1..], out var fn) && fn is >= 1 and <= 24)
        {
            return (uint)(0x70 + fn - 1);
        }

        return key.ToLowerInvariant() switch
        {
            "space" => 0x20,
            "tab" => 0x09,
            "escape" or "esc" => 0x1B,
            "enter" or "return" => 0x0D,
            "pause" => 0x13,
            _ => 0,
        };
    }

    public void Dispose()
    {
        Unregister();
    }
}

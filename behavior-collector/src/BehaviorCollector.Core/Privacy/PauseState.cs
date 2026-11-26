namespace BehaviorCollector.Core.Privacy;

/// <summary>全局暂停状态：暂停期间除 pause.start/end 外不采集。</summary>
public sealed class PauseState
{
    private int _paused;

    public bool IsPaused => Volatile.Read(ref _paused) != 0;

    public event Action<bool>? Changed;

    public bool Toggle() => Set(!IsPaused);

    public bool Set(bool paused)
    {
        var value = paused ? 1 : 0;
        var previous = Interlocked.Exchange(ref _paused, value);
        var changed = previous != value;
        if (changed)
        {
            Changed?.Invoke(paused);
        }

        return changed;
    }
}

/// <summary>明文按键是否在本次运行中生效（config + 托盘二次确认后的结果）。</summary>
public sealed class PlaintextPolicy
{
    private int _enabled;

    public bool Enabled
    {
        get => Volatile.Read(ref _enabled) != 0;
        set => Interlocked.Exchange(ref _enabled, value ? 1 : 0);
    }
}

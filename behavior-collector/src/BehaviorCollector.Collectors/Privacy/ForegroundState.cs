using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Privacy;

namespace BehaviorCollector.Collectors.Privacy;

/// <summary>前台窗口快照，供输入采集器做归属与排除判断。</summary>
public sealed record ForegroundSnapshot(IntPtr Hwnd, int Pid, string App, string Title, bool Excluded);

/// <summary>窗口采集器维护的当前前台状态。</summary>
public sealed class ForegroundState
{
    private ForegroundSnapshot? _current;

    public ForegroundSnapshot? Current => Volatile.Read(ref _current);

    internal void Update(ForegroundSnapshot? snapshot) => Volatile.Write(ref _current, snapshot);
}

/// <summary>配置热更新时重建排除名单。</summary>
public sealed class PrivacyPolicy
{
    private ExclusionMatcher _matcher = new(Array.Empty<string>());

    public PrivacyPolicy(ConfigService config)
    {
        Rebuild(config.Current);
        config.Changed += Rebuild;
    }

    public ExclusionMatcher Matcher => Volatile.Read(ref _matcher);

    private void Rebuild(CollectorConfig config)
    {
        Volatile.Write(ref _matcher, new ExclusionMatcher(config.Privacy.ExcludedApps));
    }
}

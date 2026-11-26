using System.Text.RegularExpressions;

namespace BehaviorCollector.Core.Privacy;

/// <summary>
/// 应用排除名单。模式是 glob（* 任意串、? 单字符），同时匹配 exe 名与窗口标题。
/// </summary>
public sealed class ExclusionMatcher
{
    private readonly List<Regex> _rules = new();

    public ExclusionMatcher(IEnumerable<string> patterns)
    {
        foreach (var pattern in patterns)
        {
            if (string.IsNullOrWhiteSpace(pattern))
            {
                continue;
            }

            try
            {
                var regex = "^" + Regex.Escape(pattern.Trim())
                    .Replace("\\*", ".*", StringComparison.Ordinal)
                    .Replace("\\?", ".", StringComparison.Ordinal) + "$";
                _rules.Add(new Regex(regex, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
                    TimeSpan.FromMilliseconds(50)));
            }
            catch (ArgumentException)
            {
                // 非法模式跳过，不影响其它规则。
            }
        }
    }

    public bool IsExcluded(string? app, string? title)
    {
        if (_rules.Count == 0)
        {
            return false;
        }

        foreach (var rule in _rules)
        {
            try
            {
                if (!string.IsNullOrEmpty(app) && rule.IsMatch(app))
                {
                    return true;
                }

                if (!string.IsNullOrEmpty(title) && rule.IsMatch(title))
                {
                    return true;
                }
            }
            catch (RegexMatchTimeoutException)
            {
                // 超时视为不匹配。
            }
        }

        return false;
    }
}

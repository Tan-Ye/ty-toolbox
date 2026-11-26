using BehaviorCollector.Core.Privacy;

namespace BehaviorCollector.Tests;

public sealed class ExclusionMatcherTests
{
    [Fact]
    public void MatchesAppAndTitleGlobs()
    {
        var matcher = new ExclusionMatcher(["*password*", "keepass*", "*bank*"]);

        Assert.True(matcher.IsExcluded("passwordmanager.exe", null));
        Assert.True(matcher.IsExcluded(null, "Password Safe"));
        Assert.True(matcher.IsExcluded("keepass.exe", "数据库"));
        Assert.True(matcher.IsExcluded("bankofchina.exe", null));
        Assert.False(matcher.IsExcluded("chrome.exe", "GitHub"));
        Assert.False(matcher.IsExcluded(null, null));
    }

    [Fact]
    public void ExactPattern_DoesNotMatchPrefix()
    {
        var matcher = new ExclusionMatcher(["chrome.exe"]);
        Assert.True(matcher.IsExcluded("chrome.exe", null));
        Assert.False(matcher.IsExcluded("chrome.exe.extra", null));
    }

    [Fact]
    public void EmptyPatternList_AllowsEverything()
    {
        var matcher = new ExclusionMatcher(Array.Empty<string>());
        Assert.False(matcher.IsExcluded("anything.exe", "any title"));
    }
}

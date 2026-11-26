using BehaviorCollector.Core.Browser;

namespace BehaviorCollector.Tests;

public sealed class BrowserEventMapperTests
{
    private static readonly long Now = new DateTimeOffset(2026, 11, 26, 10, 0, 0, TimeSpan.Zero)
        .ToUnixTimeMilliseconds();

    [Fact]
    public void MapsNavigationEvent()
    {
        var json = """
            {"type":"event","kind":"browser.nav","ts":1764140000000,"url":"https://example.com/a","title":"A","tabId":7,"windowId":2,"eid":"e1","spa":true}
            """;

        var record = BrowserEventMapper.Map(json, 1, Now);

        Assert.NotNull(record);
        Assert.Equal("browser.nav", record!.Kind);
        Assert.Equal("browser", record.Source);
        Assert.Equal("chrome.exe", record.App);
        Assert.Equal("https://example.com/a", record.Url);
        Assert.Equal("A", record.Title);
        Assert.Equal(1, record.Session);
        Assert.Contains("\"tab_id\":7", record.Data);
        Assert.Contains("\"spa\":true", record.Data);
        Assert.Contains("\"eid\":\"e1\"", record.Data);
    }

    [Fact]
    public void IgnoresUnknownKindsAndTypes()
    {
        Assert.Null(BrowserEventMapper.Map("""{"type":"event","kind":"browser.unknown"}""", 1, Now));
        Assert.Null(BrowserEventMapper.Map("""{"type":"ack","kind":"browser.nav"}""", 1, Now));
        Assert.Null(BrowserEventMapper.Map("not json", 1, Now));
    }

    [Fact]
    public void InvalidTimestamp_FallsBackToNow()
    {
        var json = """{"type":"event","kind":"browser.activate","ts":1,"url":"https://x.test","tabId":1}""";
        var record = BrowserEventMapper.Map(json, null, Now);

        Assert.NotNull(record);
        Assert.Equal(Now, record!.Ts);
    }
}

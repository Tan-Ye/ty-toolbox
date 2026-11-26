namespace BehaviorCollector.Core.Models;

/// <summary>
/// 一条采集事件。字段与 SQLite events 表一一对应。
/// </summary>
public sealed class EventRecord
{
    public long Ts { get; init; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>事件类型，如 window.foreground / input.key / browser.nav。</summary>
    public required string Kind { get; init; }

    /// <summary>来源：window | process | input | uia | browser | app。</summary>
    public required string Source { get; init; }

    public int? Pid { get; init; }
    public long? Hwnd { get; init; }
    public string? App { get; init; }
    public string? Title { get; init; }
    public string? Url { get; init; }
    public int? Session { get; init; }

    /// <summary>按 kind 不同的 JSON 负载。</summary>
    public string? Data { get; init; }

    /// <summary>仅当 privacy.plaintextKeys 打开时写入。</summary>
    public string? KeyPlain { get; init; }
}

using System.Text;
using System.Text.Json;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Util;

namespace BehaviorCollector.Core.Browser;

/// <summary>把扩展上报的 JSON 映射成 events 行。</summary>
public static class BrowserEventMapper
{
    private static readonly long MinValidTs = new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero)
        .ToUnixTimeMilliseconds();

    public static EventRecord? Map(string json, int? session, long? nowMs = null)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (root.TryGetProperty("type", out var type) &&
                !string.Equals(type.GetString(), "event", StringComparison.Ordinal))
            {
                return null;
            }

            if (!root.TryGetProperty("kind", out var kindEl))
            {
                return null;
            }

            var kind = kindEl.GetString();
            if (kind is not ("browser.nav" or "browser.activate"))
            {
                return null;
            }

            var now = nowMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var ts = now;
            if (root.TryGetProperty("ts", out var tsEl) && tsEl.ValueKind == JsonValueKind.Number &&
                tsEl.TryGetInt64(out var rawTs) && rawTs >= MinValidTs && rawTs <= now + 86_400_000)
            {
                ts = rawTs;
            }

            var url = GetString(root, "url", 2048);
            var title = GetString(root, "title", 512);
            var data = BuildData(root);

            return new EventRecord
            {
                Ts = ts,
                Kind = kind,
                Source = "browser",
                App = "chrome.exe",
                Title = title,
                Url = url,
                Session = session,
                Data = data,
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string BuildData(JsonElement root)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            WriteString(writer, "eid", root, "eid");
            WriteNumber(writer, "tab_id", root, "tabId");
            WriteNumber(writer, "window_id", root, "windowId");
            if (root.TryGetProperty("spa", out var spa) && (spa.ValueKind is JsonValueKind.True or JsonValueKind.False))
            {
                writer.WriteBoolean("spa", spa.GetBoolean());
            }

            WriteString(writer, "transition", root, "transition");
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteString(Utf8JsonWriter writer, string name, JsonElement root, string prop)
    {
        if (root.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String)
        {
            writer.WriteString(name, el.GetString());
        }
    }

    private static void WriteNumber(Utf8JsonWriter writer, string name, JsonElement root, string prop)
    {
        if (root.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.Number &&
            el.TryGetInt64(out var value))
        {
            writer.WriteNumber(name, value);
        }
    }

    private static string? GetString(JsonElement root, string prop, int maxLength)
    {
        if (!root.TryGetProperty(prop, out var el) || el.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var value = el.GetString();
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        return value.Length <= maxLength ? value : value[..maxLength];
    }
}

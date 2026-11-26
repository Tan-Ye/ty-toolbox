using System.Text.Json;
using BehaviorCollector.Core.Util;

namespace BehaviorCollector.Core.Diagnostics;

public static class InputHookStates
{
    public const string Starting = "starting";
    public const string Running = "running";
    public const string Faulted = "faulted";
    public const string Stopped = "stopped";
}

public sealed record InputHookStatus(
    string State,
    string? Message,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? EnabledAt);

/// <summary>
/// 输入钩子生命周期状态，供另一个进程的 --status 读取。
/// 写入是 best-effort：状态文件失败不能影响采集。
/// </summary>
public sealed class InputHookStatusStore
{
    private readonly string _path;
    private readonly object _gate = new();
    private InputHookStatus _current = new(InputHookStates.Starting, null, DateTimeOffset.UtcNow, null);

    public InputHookStatusStore(string path)
    {
        _path = Path.GetFullPath(path);
    }

    public string FilePath => _path;

    public InputHookStatus Current
    {
        get
        {
            lock (_gate)
            {
                return _current;
            }
        }
    }

    public void SetState(string state, string? message = null)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var enabledAt = state == InputHookStates.Running
                ? _current.EnabledAt ?? now
                : _current.EnabledAt;

            _current = new InputHookStatus(state, message, now, enabledAt);
            PersistLocked();
        }
    }

    public static InputHookStatus? Read(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<InputHookStatus>(json, JsonDefaults.Compact);
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private void PersistLocked()
    {
        try
        {
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_current, JsonDefaults.Compact));
            File.Move(temp, _path, overwrite: true);
        }
        catch (IOException)
        {
            // 状态文件是诊断旁路，不能影响输入采集。
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}

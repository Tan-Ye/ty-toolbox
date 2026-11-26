using BehaviorCollector.Collectors.Win32;

namespace BehaviorCollector.Tests;

public sealed class ProcessEnumerationTests
{
    [Fact]
    public void EnumerateProcesses_IncludesCurrentProcess()
    {
        var processes = Win32Util.EnumerateProcesses();

        Assert.NotEmpty(processes);
        Assert.Contains(processes, p => p.Pid == Environment.ProcessId);
        Assert.Contains(processes, p => !string.IsNullOrWhiteSpace(p.ExeName));
    }
}

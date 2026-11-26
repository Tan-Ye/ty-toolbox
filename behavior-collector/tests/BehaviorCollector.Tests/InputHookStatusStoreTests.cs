using BehaviorCollector.Core.Diagnostics;

namespace BehaviorCollector.Tests;

public sealed class InputHookStatusStoreTests
{
    [Fact]
    public void WritesAndReadsLifecycleState()
    {
        var dir = Path.Combine(Path.GetTempPath(), "bc-hook-status-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "input-hook-status.json");

        try
        {
            var store = new InputHookStatusStore(path);

            store.SetState(InputHookStates.Starting);
            var starting = InputHookStatusStore.Read(path);
            Assert.NotNull(starting);
            Assert.Equal(InputHookStates.Starting, starting!.State);

            store.SetState(InputHookStates.Running);
            var running = InputHookStatusStore.Read(path);
            Assert.NotNull(running);
            Assert.Equal(InputHookStates.Running, running!.State);
            Assert.NotNull(running.EnabledAt);

            store.SetState(InputHookStates.Faulted, "SetWindowsHookEx failed");
            var faulted = InputHookStatusStore.Read(path);
            Assert.NotNull(faulted);
            Assert.Equal(InputHookStates.Faulted, faulted!.State);
            Assert.Equal("SetWindowsHookEx failed", faulted.Message);
            Assert.NotNull(faulted.EnabledAt);
        }
        finally
        {
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    [Fact]
    public void MissingFileReadsAsNull()
    {
        var path = Path.Combine(Path.GetTempPath(), "bc-hook-missing-" + Guid.NewGuid().ToString("N") + ".json");
        Assert.Null(InputHookStatusStore.Read(path));
    }
}

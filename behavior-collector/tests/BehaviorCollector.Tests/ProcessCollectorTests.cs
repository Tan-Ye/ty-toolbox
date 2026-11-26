using System.Diagnostics;
using BehaviorCollector.Collectors;
using BehaviorCollector.Core;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Privacy;
using Microsoft.Extensions.Logging.Abstractions;

namespace BehaviorCollector.Tests;

public sealed class ProcessCollectorTests
{
    [Fact]
    public async Task CollectsChildProcessStartAndStop()
    {
        var dir = Path.Combine(Path.GetTempPath(), "bc-proc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var config = new ConfigService(Path.Combine(dir, "config.json"));
            config.Load();
            var bus = new EventBus();
            var pause = new PauseState();
            var collector = new ProcessCollector(bus, config, pause,
                NullLogger<ProcessCollector>.Instance);

            await collector.StartAsync(CancellationToken.None);
            await Task.Delay(3000); // 建立基线

            using var child = Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 8 127.0.0.1")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            });

            Assert.NotNull(child);
            await Task.Delay(4000);
            child!.Kill();
            await Task.Delay(5000);
            await collector.StopAsync(CancellationToken.None);

            var events = new List<EventRecord>();
            while (bus.Reader.TryRead(out var e))
            {
                events.Add(e);
            }

            Assert.Contains(events, e => e.Kind == "process.start" && e.Pid == child.Id);
            Assert.Contains(events, e => e.Kind == "process.stop" && e.Pid == child.Id);
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
}

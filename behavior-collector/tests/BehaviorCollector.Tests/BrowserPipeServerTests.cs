using System.IO.Pipes;
using System.Text;
using BehaviorCollector.Collectors.Browser;
using BehaviorCollector.Core.Config;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Models;
using BehaviorCollector.Core.Privacy;
using Microsoft.Extensions.Logging.Abstractions;

namespace BehaviorCollector.Tests;

public sealed class BrowserPipeServerTests
{
    [Fact]
    public async Task ReceivesEventFromNamedPipe()
    {
        var dir = Path.Combine(Path.GetTempPath(), "bc-pipe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var pipeName = "bc-test-" + Guid.NewGuid().ToString("N");
        try
        {
            var config = new ConfigService(Path.Combine(dir, "config.json"));
            config.Load();
            var bus = new EventBus();
            var pause = new PauseState();
            var server = new BrowserPipeServer(bus, config, pause,
                NullLogger<BrowserPipeServer>.Instance, pipeName);

            await server.StartAsync(CancellationToken.None);
            await using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out,
                PipeOptions.Asynchronous);

            for (var attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    await client.ConnectAsync(200);
                    break;
                }
                catch (TimeoutException)
                {
                    await Task.Delay(100);
                }
            }

            await using (var writer = new StreamWriter(client, new UTF8Encoding(false)))
            {
                await writer.WriteLineAsync(
                    """{"type":"event","kind":"browser.nav","url":"https://pipe.test/a","title":"Pipe","tabId":1,"windowId":2,"eid":"p1"}""");
                await writer.FlushAsync();
            }

            await Task.Delay(500);
            await server.StopAsync(CancellationToken.None);

            var events = new List<EventRecord>();
            while (bus.Reader.TryRead(out var e))
            {
                events.Add(e);
            }

            Assert.Contains(events, e => e.Kind == "browser.nav" && e.Url == "https://pipe.test/a");
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

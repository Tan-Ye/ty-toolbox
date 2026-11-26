using BehaviorCollector.Core.Browser;
using BehaviorCollector.Core.Storage;

namespace BehaviorCollector.Tests;

public sealed class BrowserSpoolImporterTests
{
    [Fact]
    public void ImportsSpoolAndDeletesFile()
    {
        var dir = Path.Combine(Path.GetTempPath(), "bc-spool-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var dbPath = Path.Combine(dir, "events.db");
        var spoolPath = Path.Combine(dir, "browser-spool.jsonl");

        try
        {
            Database.EnsureCreated(dbPath);
            File.WriteAllLines(spoolPath,
            [
                """{"type":"event","kind":"browser.nav","url":"https://spool.test/1","title":"A","tabId":1,"windowId":1,"eid":"s1"}""",
                """not-json""",
                """{"type":"event","kind":"browser.activate","url":"https://spool.test/2","title":"B","tabId":2,"windowId":1,"eid":"s2"}""",
            ]);

            var imported = BrowserSpoolImporter.Import(dbPath, spoolPath, 1);

            Assert.Equal(2, imported);
            Assert.False(File.Exists(spoolPath));
            var status = EventQuery.QueryStatus(dbPath);
            Assert.Equal(2, status.TotalEvents);
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

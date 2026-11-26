using System.Text;
using BehaviorCollector.Core.Browser;

namespace BehaviorCollector.Tests;

public sealed class NativeMessagingProtocolTests
{
    [Fact]
    public async Task WriteThenRead_RoundTripsMultipleMessages()
    {
        var stream = new MemoryStream();
        await NativeMessagingProtocol.WriteMessageAsync(stream, "{\"a\":1}", CancellationToken.None);
        await NativeMessagingProtocol.WriteMessageAsync(stream, "{\"b\":2}", CancellationToken.None);
        stream.Position = 0;

        Assert.Equal("{\"a\":1}", await NativeMessagingProtocol.ReadMessageAsync(stream, CancellationToken.None));
        Assert.Equal("{\"b\":2}", await NativeMessagingProtocol.ReadMessageAsync(stream, CancellationToken.None));
        Assert.Null(await NativeMessagingProtocol.ReadMessageAsync(stream, CancellationToken.None));
    }

    [Fact]
    public async Task ClosedStream_ReturnsNull()
    {
        Assert.Null(await NativeMessagingProtocol.ReadMessageAsync(new MemoryStream(), CancellationToken.None));
    }

    [Fact]
    public async Task OversizedLength_Throws()
    {
        var stream = new MemoryStream();
        stream.Write(new byte[] { 0xFF, 0xFF, 0xFF, 0xFF });
        stream.Position = 0;

        await Assert.ThrowsAsync<InvalidDataException>(() =>
            NativeMessagingProtocol.ReadMessageAsync(stream, CancellationToken.None));
    }

    [Fact]
    public async Task TruncatedPayload_Throws()
    {
        var payload = Encoding.UTF8.GetBytes("{\"x\":1}");
        var stream = new MemoryStream();
        var header = BitConverter.GetBytes((uint)payload.Length + 10);
        stream.Write(header);
        stream.Write(payload);
        stream.Position = 0;

        await Assert.ThrowsAsync<EndOfStreamException>(() =>
            NativeMessagingProtocol.ReadMessageAsync(stream, CancellationToken.None));
    }
}

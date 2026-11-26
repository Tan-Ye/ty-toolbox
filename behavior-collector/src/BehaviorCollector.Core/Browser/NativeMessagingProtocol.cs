using System.Buffers.Binary;
using System.Text;

namespace BehaviorCollector.Core.Browser;

/// <summary>
/// Chrome Native Messaging 的二进制帧：4 字节小端长度 + UTF-8 JSON。
/// </summary>
public static class NativeMessagingProtocol
{
    public const uint MaxMessageBytes = 4 * 1024 * 1024;

    /// <returns>null 表示 stdin 已关闭（Chrome 退出）。</returns>
    public static async Task<string?> ReadMessageAsync(Stream input, CancellationToken ct)
    {
        var header = new byte[4];
        var read = await ReadExactAsync(input, header, ct);
        if (read == 0)
        {
            return null;
        }

        if (read < header.Length)
        {
            throw new EndOfStreamException("Native Messaging 头部不完整");
        }

        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length == 0 || length > MaxMessageBytes)
        {
            throw new InvalidDataException($"Native Messaging 长度非法：{length}");
        }

        var payload = new byte[length];
        if (await ReadExactAsync(input, payload, ct) < payload.Length)
        {
            throw new EndOfStreamException("Native Messaging 负载不完整");
        }

        return Encoding.UTF8.GetString(payload);
    }

    public static async Task WriteMessageAsync(Stream output, string json, CancellationToken ct)
    {
        var payload = Encoding.UTF8.GetBytes(json);
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)payload.Length);
        await output.WriteAsync(header, ct);
        await output.WriteAsync(payload, ct);
        await output.FlushAsync(ct);
    }

    private static async Task<int> ReadExactAsync(Stream input, byte[] buffer, CancellationToken ct)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await input.ReadAsync(buffer.AsMemory(offset), ct);
            if (read == 0)
            {
                break;
            }

            offset += read;
        }

        return offset;
    }
}

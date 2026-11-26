using System.Buffers.Binary;
using System.Security.Cryptography;

namespace BehaviorCollector.Core.Privacy;

/// <summary>
/// 按键哈希：HMAC-SHA256(salt, vk|mods) 取前 16 hex。盐随机、只存本机。
/// </summary>
public sealed class KeyHasher
{
    private readonly byte[] _salt;

    public KeyHasher(byte[] salt)
    {
        if (salt.Length == 0)
        {
            throw new ArgumentException("盐不能为空", nameof(salt));
        }

        _salt = salt;
    }

    public string Hash(ushort virtualKey, uint modifiers)
    {
        Span<byte> input = stackalloc byte[6];
        BinaryPrimitives.WriteUInt16LittleEndian(input, virtualKey);
        BinaryPrimitives.WriteUInt32LittleEndian(input[2..], modifiers);
        var hash = HMACSHA256.HashData(_salt, input);
        return Convert.ToHexString(hash.AsSpan(0, 8)).ToLowerInvariant();
    }
}

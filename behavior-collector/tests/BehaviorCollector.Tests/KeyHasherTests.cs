using BehaviorCollector.Core.Privacy;

namespace BehaviorCollector.Tests;

public sealed class KeyHasherTests
{
    private static byte[] Salt(byte seed) => Enumerable.Range(0, 32).Select(i => (byte)(i + seed)).ToArray();

    [Fact]
    public void Hash_IsDeterministic_And16Hex()
    {
        var hasher = new KeyHasher(Salt(0));
        var first = hasher.Hash(0x41, 2);
        var second = hasher.Hash(0x41, 2);

        Assert.Equal(first, second);
        Assert.Equal(16, first.Length);
        Assert.Matches("^[0-9a-f]{16}$", first);
    }

    [Fact]
    public void Hash_DiffersByModifiers()
    {
        var hasher = new KeyHasher(Salt(1));
        Assert.NotEqual(hasher.Hash(0x41, 0), hasher.Hash(0x41, 2));
    }

    [Fact]
    public void Hash_DiffersBySalt()
    {
        Assert.NotEqual(new KeyHasher(Salt(0)).Hash(0x41, 2), new KeyHasher(Salt(9)).Hash(0x41, 2));
    }
}

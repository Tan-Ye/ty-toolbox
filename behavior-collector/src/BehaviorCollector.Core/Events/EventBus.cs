using System.Threading.Channels;
using BehaviorCollector.Core.Models;

namespace BehaviorCollector.Core.Events;

/// <summary>
/// 采集器到写库线程的唯一通道。有界、满了不阻塞采集器，只累加丢弃计数。
/// </summary>
public sealed class EventBus
{
    public const int DefaultCapacity = 50_000;

    private readonly Channel<EventRecord> _channel;
    private long _dropped;

    public EventBus(int capacity = DefaultCapacity)
    {
        _channel = Channel.CreateBounded<EventRecord>(new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
        });
    }

    public ChannelReader<EventRecord> Reader => _channel.Reader;

    public long DroppedCount => Interlocked.Read(ref _dropped);

    /// <returns>true 表示已入队；false 表示通道已满或已关闭，事件被丢弃。</returns>
    public bool Emit(EventRecord record)
    {
        if (_channel.Writer.TryWrite(record))
        {
            return true;
        }

        Interlocked.Increment(ref _dropped);
        return false;
    }

    public void Complete() => _channel.Writer.TryComplete();
}

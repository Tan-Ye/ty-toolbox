namespace BehaviorCollector.App;

internal sealed class SingleInstance : IDisposable
{
    public const string Name = @"Local\BehaviorCollector.SingleInstance";

    private readonly Mutex _mutex;

    public bool IsOwner { get; }

    public SingleInstance()
    {
        _mutex = new Mutex(initiallyOwned: true, Name, out var createdNew);
        IsOwner = createdNew;
    }

    public static bool IsRunning()
    {
        try
        {
            using var mutex = Mutex.OpenExisting(Name);
            return true;
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return true;
        }
    }

    public void Dispose()
    {
        if (IsOwner)
        {
            try
            {
                _mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
            }
        }

        _mutex.Dispose();
    }
}

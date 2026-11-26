using BehaviorCollector.Collectors.Win32;

namespace BehaviorCollector.Collectors;

public static class SessionInfo
{
    public static int Current => Win32Util.CurrentSessionId;
}

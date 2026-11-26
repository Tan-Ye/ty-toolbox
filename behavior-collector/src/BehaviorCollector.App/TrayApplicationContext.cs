using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using BehaviorCollector.Core;
using BehaviorCollector.Core.Events;
using BehaviorCollector.Core.Privacy;
using BehaviorCollector.Core.Storage;
using Microsoft.Extensions.Logging;

namespace BehaviorCollector.App;

/// <summary>托盘 UI：状态、暂停/继续、打开数据目录、退出；并轮询 --quit 信号。</summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    public const string QuitEventName = @"Local\BehaviorCollector.Quit";

    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _pauseItem;
    private readonly EventWaitHandle _quitEvent;
    private readonly System.Windows.Forms.Timer _timer;
    private readonly EventBus _bus;
    private readonly PauseState _pause;
    private readonly BatchWriter _writer;
    private readonly AppPaths _paths;
    private readonly ILogger _logger;
    private readonly Action _onExit;
    private int _exiting;

    public TrayApplicationContext(
        EventBus bus,
        PauseState pause,
        BatchWriter writer,
        AppPaths paths,
        ILogger logger,
        Action onExit)
    {
        _bus = bus;
        _pause = pause;
        _writer = writer;
        _paths = paths;
        _logger = logger;
        _onExit = onExit;

        _pauseItem = new ToolStripMenuItem("暂停采集");
        _pauseItem.Click += (_, _) => _pause.Toggle();

        var menu = new ContextMenuStrip();
        menu.Items.Add(_pauseItem);
        menu.Items.Add(new ToolStripMenuItem("状态", null, (_, _) => ShowStatus()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("打开数据目录", null, (_, _) => OpenDataDirectory()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("退出", null, (_, _) => RequestExit()));

        _notifyIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "BehaviorCollector · 采集中",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _notifyIcon.DoubleClick += (_, _) => ShowStatus();

        _quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName);
        _timer = new System.Windows.Forms.Timer { Interval = 1000 };
        _timer.Tick += OnTimerTick;
        _timer.Start();

        _pause.Changed += OnPauseChanged;
        UpdatePauseUi(_pause.IsPaused);
        _notifyIcon.ShowBalloonTip(3000, "BehaviorCollector", "已启动，正在采集行为事件", ToolTipIcon.Info);
    }

    public void RequestExit()
    {
        if (Interlocked.Exchange(ref _exiting, 1) != 0)
        {
            return;
        }

        _timer.Stop();
        _notifyIcon.Visible = false;
        try
        {
            _onExit();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "退出清理失败");
        }

        ExitThread();
    }

    private void OnTimerTick(object? sender, EventArgs e)
    {
        if (_quitEvent.WaitOne(0))
        {
            RequestExit();
        }
    }

    private void OnPauseChanged(bool paused)
    {
        UpdatePauseUi(paused);
    }

    private void UpdatePauseUi(bool paused)
    {
        _pauseItem.Text = paused ? "继续采集" : "暂停采集";
        _notifyIcon.Icon = paused ? SystemIcons.Warning : SystemIcons.Application;
        _notifyIcon.Text = paused ? "BehaviorCollector · 已暂停" : "BehaviorCollector · 采集中";
    }

    private void ShowStatus()
    {
        try
        {
            var status = EventQuery.QueryStatus(_paths.DatabasePath);
            var text = $"今日 {status.TodayTotal} 条 · 累计 {status.TotalEvents} 条\n" +
                       $"丢弃 {_bus.DroppedCount} 条 · 写入 {_writer.WrittenCount} 条\n" +
                       $"数据库 {status.DbSizeBytes / 1024 / 1024.0:F1} MB";
            _notifyIcon.ShowBalloonTip(5000, _pause.IsPaused ? "BehaviorCollector（已暂停）" : "BehaviorCollector",
                text, ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "读取状态失败");
        }
    }

    private void OpenDataDirectory()
    {
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_paths.DataDirectory}\"")
            {
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "打开数据目录失败");
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
            _notifyIcon.Dispose();
            _quitEvent.Dispose();
            _pause.Changed -= OnPauseChanged;
        }

        base.Dispose(disposing);
    }
}

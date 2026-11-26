using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using BehaviorCollector.Core.Browser;
using BehaviorCollector.Core;
using Microsoft.Extensions.Logging;

namespace BehaviorCollector.Collectors.Browser;

/// <summary>
/// Chrome Native Messaging 宿主（由 Chrome 以第一个参数 chrome-extension:// 启动）。
/// 把扩展消息转发给主程序的命名管道；主程序不在时落 browser-spool.jsonl。
/// 注意：stdout 是 Native Messaging 协议通道，绝不能打印日志。
/// </summary>
public static class BrowserHostRunner
{
    public static async Task<int> RunAsync(AppPaths paths, CancellationToken ct)
    {
        using var input = Console.OpenStandardInput();
        using var forwarder = new PipeForwarder(paths.BrowserSpoolPath);
        while (!ct.IsCancellationRequested)
        {
            string? message;
            try
            {
                message = await NativeMessagingProtocol.ReadMessageAsync(input, ct);
            }
            catch (Exception)
            {
                // 协议错误/管道关闭：直接退出，Chrome 会重连。
                break;
            }

            if (message is null)
            {
                break;
            }

            if (BrowserEventMapper.Map(message, null) is null)
            {
                continue;
            }

            forwarder.Forward(message);
        }

        return 0;
    }

    private sealed class PipeForwarder : IDisposable
    {
        private readonly string _spoolPath;
        private StreamWriter? _pipeWriter;
        private NamedPipeClientStream? _pipe;

        public PipeForwarder(string spoolPath)
        {
            _spoolPath = spoolPath;
        }

        public void Forward(string message)
        {
            if (TryWritePipe(message))
            {
                return;
            }

            TrySpool(message);
        }

        private bool TryWritePipe(string message)
        {
            try
            {
                if (_pipeWriter is null)
                {
                    _pipe = new NamedPipeClientStream(".", BrowserConstants.PipeName, PipeDirection.Out,
                        PipeOptions.Asynchronous);
                    _pipe.Connect(150);
                    _pipeWriter = new StreamWriter(_pipe, new UTF8Encoding(false)) { AutoFlush = true };
                }

                _pipeWriter.WriteLine(message);
                return true;
            }
            catch (Exception)
            {
                ClosePipe();
                return false;
            }
        }

        private void TrySpool(string message)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_spoolPath)!);
                File.AppendAllText(_spoolPath, message + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (Exception)
            {
                // 写入缓冲也失败就只能丢弃，避免宿主崩溃导致 Chrome 疯狂重连。
            }
        }

        private void ClosePipe()
        {
            try
            {
                _pipeWriter?.Dispose();
                _pipe?.Dispose();
            }
            catch (Exception)
            {
            }

            _pipeWriter = null;
            _pipe = null;
        }

        public void Dispose() => ClosePipe();
    }
}

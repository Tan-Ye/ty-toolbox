/**
 * Windows Toast 通知出口。
 *
 * 用 PowerShell 5.1 调 WinRT（系统自带，不引第三方依赖）。
 * 两个坑：
 *  1. PowerShell 5.1 读无 BOM 的 .ps1 会把中文解成乱码 —— 写文件时加 UTF-8 BOM；
 *  2. 命令行传中文参数容易在代码页转换中失真 —— 改用环境变量传，PowerShell 侧读 $env:。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOAST_SCRIPT = `$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:BUTLER_TOAST_TITLE)) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($env:BUTLER_TOAST_MESSAGE)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($t)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;

let scriptPath = null;

function ensureScript() {
  if (scriptPath) return scriptPath;
  const dir = path.join(os.tmpdir(), 'butler');
  mkdirSync(dir, { recursive: true });
  scriptPath = path.join(dir, 'toast.ps1');
  writeFileSync(scriptPath, '\uFEFF' + TOAST_SCRIPT, 'utf8');
  return scriptPath;
}

/**
 * 弹一条 Windows 通知。失败不抛错（提醒不是关键路径），但会通过 onError 回调上报。
 * @returns {Promise<{ok:boolean, code?:number, error?:string}>}
 */
export function showToast({ title, message, onError } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureScript()], {
        env: { ...process.env, BUTLER_TOAST_TITLE: String(title ?? ''), BUTLER_TOAST_MESSAGE: String(message ?? '') },
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      onError?.(error);
      resolve({ ok: false, error: String(error) });
      return;
    }

    child.on('error', (error) => {
      onError?.(error);
      resolve({ ok: false, error: String(error) });
    });
    child.on('exit', (code) => resolve({ ok: code === 0, code }));
  });
}

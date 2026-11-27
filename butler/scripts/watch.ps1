# 登录后在后台启动 butler watch（无窗口）。
# 由计划任务 ButlerWatch 在用户登录时调用；也可手动运行。
# 日志：../logs/watch.log（stdout）与 ../logs/watch.err.log（stderr）

$butler = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $butler 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$node = 'C:\Program Files\nodejs\node.exe'
$index = Join-Path $butler 'src\index.js'

Start-Process -FilePath $node `
  -ArgumentList @($index, 'watch') `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'watch.log') `
  -RedirectStandardError (Join-Path $logDir 'watch.err.log')

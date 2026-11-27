# 每天把前一天的日报导入 Kotana 记忆。
# 由计划任务 ButlerDailyImport 在每天 00:05 调用；也可手动运行验证。
# 逻辑：算昨天 → daily --save（落盘报告）→ memory（写一条 ≤200 字的记忆）
# 幂等：同一天重复导入会覆盖同一条 butler-daily-YYYY-MM-DD 记忆。

$ErrorActionPreference = 'Stop'
# 让 Windows PowerShell 5.1 按 UTF-8 解码 node 子进程的输出，否则中文会乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$butler = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $butler 'logs'
$log = Join-Path $logDir 'import.log'
$node = 'C:\Program Files\nodejs\node.exe'
$index = Join-Path $butler 'src\index.js'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$text) {
  "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] $text" | Add-Content -Path $log -Encoding UTF8
}

$date = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
Write-Log "开始导入 $date"

try {
  # 1. 生成日报并存到 reports/
  & $node $index daily --date $date --save 2>&1 | ForEach-Object { "$_" } | Add-Content -Path $log -Encoding UTF8
  $dailyExit = $LASTEXITCODE

  # 2. 日报 → Kotana 记忆
  & $node $index memory --date $date 2>&1 | ForEach-Object { "$_" } | Add-Content -Path $log -Encoding UTF8

  # 3. 日报摘要 → QQ outbox（Kotana 进程连着 QQ 时会在 5 秒内发出去）
  & $node $index notify --date $date 2>&1 | ForEach-Object { "$_" } | Add-Content -Path $log -Encoding UTF8

  Write-Log "导入结束 daily=$dailyExit memory=$LASTEXITCODE"
}
catch {
  Write-Log "导入失败: $($_.Exception.Message)"
  exit 1
}

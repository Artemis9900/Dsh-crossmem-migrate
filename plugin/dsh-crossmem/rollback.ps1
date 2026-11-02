# Soft rollback for dsh-crossmem: stop injecting / capturing, keep the plugin installed.
#
# This is the recommended "undo": no uninstall, no dsh restart. The plugin keeps
# its tools (crossmem_search / save / stats / recent) but stays quiet.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\rollback.ps1
#   powershell -ExecutionPolicy Bypass -File .\rollback.ps1 -On         # turn it back on
#   powershell -ExecutionPolicy Bypass -File .\rollback.ps1 -OnlyCapture
#   powershell -ExecutionPolicy Bypass -File .\rollback.ps1 -Status
# ASCII only in code strings: Windows PowerShell 5.1 reads .ps1 as ANSI.
param(
  [switch]$On,
  [switch]$OnlyCapture,
  [switch]$Status,
  [string]$Reason = "manual rollback",
  [switch]$List,
  [string]$Link = "",
  [string]$Unlink = "",
  [switch]$Scan,
  [string]$ScanCwd = "",
  [string]$StateFile = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($StateFile)) {
  $StateFile = Join-Path $env:USERPROFILE ".dsh-crossmem\state.json"
}

function Read-State {
  if (-not (Test-Path $StateFile)) { return $null }
  try { return (Get-Content $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-State($inject, $capture, $why) {
  $dir = Split-Path -Parent $StateFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $obj = [ordered]@{
    inject  = $inject
    capture = $capture
    reason  = $why
    at      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  if ($why -eq "" ) { $obj.Remove("reason") }
  # No BOM: the plugin JSON.parses this file.
  [System.IO.File]::WriteAllText($StateFile, ($obj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ""
Write-Host "=== dsh-crossmem rollback ===" -ForegroundColor Cyan
Write-Host "state file : $StateFile"
Write-Host ""

function Read-StateJson {
  if (-not (Test-Path $StateFile)) { return [ordered]@{ inject = $true; capture = $true; linkedSessions = @(); reason = ""; at = 0 } }
  try { return (Get-Content $StateFile -Raw | ConvertFrom-Json) } catch { return [ordered]@{ inject = $true; capture = $true; linkedSessions = @(); reason = ""; at = 0 } }
}

if ($List -or $Link -or $Unlink) {
  $st = Read-StateJson
  $linked = @()
  if ($st.linkedSessions) { $linked = @($st.linkedSessions) }

  if ($Link) {
    if ($linked -notcontains $Link) { $linked += $Link }
    Write-State $st.inject $st.capture $st.reason | Out-Null
    $obj = [ordered]@{ inject = $st.inject; capture = $st.capture; linkedSessions = $linked; reason = $st.reason; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    [System.IO.File]::WriteAllText($StateFile, ($obj | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("  linked: " + $Link) -ForegroundColor Green
  }
  if ($Unlink) {
    $linked = @($linked | Where-Object { $_ -ne $Unlink })
    $obj = [ordered]@{ inject = $st.inject; capture = $st.capture; linkedSessions = $linked; reason = $st.reason; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    [System.IO.File]::WriteAllText($StateFile, ($obj | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("  unlinked: " + $Unlink) -ForegroundColor Yellow
  }
  if ($List) {
    Write-Host ("  linked sessions (" + $linked.Count + "):") -ForegroundColor Cyan
    if ($linked.Count -eq 0) { Write-Host "    (empty = all sessions share memory)" -ForegroundColor DarkGray }
    foreach ($x in $linked) { Write-Host ("    - " + $x) }
  }
  Write-Host ""
  exit 0
}

if ($Scan) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    foreach ($c in @("H:\node js\node.exe", (Join-Path $env:ProgramFiles "nodejs\node.exe"))) { if (Test-Path $c) { $node = $c; break } }
  }
  if (-not $node) { Write-Host "  node not found; cannot scan" -ForegroundColor Red; exit 1 }
  $exe = if ($node -is [string]) { $node } else { $node.Source }
  $scanner = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "scan-injection.mjs"
  if (-not (Test-Path $scanner)) { Write-Host "  scan-injection.mjs missing" -ForegroundColor Red; exit 1 }
  $args2 = @($scanner, "--all")
  if ($ScanCwd) { $args2 = @($scanner, "--cwd", $ScanCwd) }
  & $exe @args2
  Write-Host ""
  exit 0
}

if ($Status) {
  $st = Read-State
  if (-not $st) {
    Write-Host "  no state file -> everything ON (default)" -ForegroundColor Green
  } else {
    $when = if ($st.at) { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$st.at).LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "?" }
    Write-Host ("  inject  : " + $(if ($st.inject -eq $false) { "OFF" } else { "ON" }))
    Write-Host ("  capture : " + $(if ($st.capture -eq $false) { "OFF" } else { "ON" }))
    Write-Host ("  reason  : " + $(if ($st.reason) { $st.reason } else { "-" }))
    Write-Host ("  updated : " + $when)
  }
  Write-Host ""
  exit 0
}

if ($On) {
  Write-State $true $true ""
  Write-Host "  inject=ON  capture=ON" -ForegroundColor Green
  Write-Host "  plugin is fully active again (no restart needed)" -ForegroundColor Green
} elseif ($OnlyCapture) {
  $st = Read-State
  $inject = if ($st -and $st.inject -eq $false) { $false } else { $true }
  Write-State $inject $false $Reason
  Write-Host "  inject=ON  capture=OFF" -ForegroundColor Yellow
  Write-Host "  memories are still injected; nothing new is recorded" -ForegroundColor Yellow
} else {
  Write-State $false $false $Reason
  Write-Host "  inject=OFF  capture=OFF" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  What still works:" -ForegroundColor Green
  Write-Host "    + crossmem_search / crossmem_save / crossmem_stats / crossmem_recent"
  Write-Host "    + the plugin stays installed (settings page intact)"
  Write-Host ""
  Write-Host "  What stopped:" -ForegroundColor Yellow
  Write-Host "    - injecting memories into the system prompt"
  Write-Host "    - automatic capture (heuristic and local model)"
  Write-Host ""
  Write-Host "  Effective immediately (no dsh restart needed)." -ForegroundColor Green
}

Write-Host ""
Write-Host "  Undo this      : .\rollback.ps1 -On" -ForegroundColor DarkGray
Write-Host "  Full uninstall : .\uninstall.ps1   (removes files; add -PurgeData to delete memories)" -ForegroundColor DarkGray
Write-Host ""

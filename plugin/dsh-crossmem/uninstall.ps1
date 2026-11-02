# Uninstall dsh-crossmem from a dsh profile.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -PurgeData   # also delete the memories it wrote
# ASCII only in code strings: Windows PowerShell 5.1 reads .ps1 as ANSI.
param(
  [string]$Profile = "desktop",
  [string]$DshHome = "",
  [switch]$PurgeData
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:USERPROFILE ".dsh"
}
$profileDir = Join-Path (Join-Path $DshHome "profiles") $Profile
$target = Join-Path $profileDir "node_modules\dsh-crossmem"
$pkgFile = Join-Path $profileDir "package.json"

Write-Host ""
Write-Host "=== dsh-crossmem uninstaller ===" -ForegroundColor Cyan
Write-Host "profile : $Profile"
Write-Host "target  : $target"
Write-Host ""

if (-not (Test-Path $profileDir)) {
  Write-Host "ERROR: profile directory not found: $profileDir" -ForegroundColor Red
  exit 1
}

# ------------------------------------------------------- 1. remove from package.json
Write-Host "[1/3] updating package.json ..."
if (Test-Path $pkgFile) {
  $backup = "$pkgFile.bak-uninstall-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $pkgFile $backup -Force
  Write-Host "      backup -> $backup"

  $raw = [System.IO.File]::ReadAllText($pkgFile)
  $pkg = $raw | ConvertFrom-Json

  if (@($pkg.dsh.profile.bundles) -contains "dsh-crossmem") {
    $bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne "dsh-crossmem" }
    $pkg.dsh.profile.bundles = @($bundles)
    Write-Host "      removed from bundles"
  } else {
    Write-Host "      not in bundles (nothing to remove)"
  }

  if (@($pkg.dependencies.PSObject.Properties.Name) -contains "dsh-crossmem") {
    $pkg.dependencies.PSObject.Properties.Remove("dsh-crossmem")
    Write-Host "      removed from dependencies"
  }

  # No BOM.
  [System.IO.File]::WriteAllText($pkgFile, ($pkg | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "      bundles now:"
  foreach ($b in @($pkg.dsh.profile.bundles)) { Write-Host "        - $b" }
} else {
  Write-Host "      no package.json, skipped" -ForegroundColor Yellow
}

# ------------------------------------------------------------------- 2. remove files
Write-Host "[2/3] removing plugin files ..."
if (Test-Path $target) {
  try {
    Remove-Item $target -Recurse -Force
    Write-Host "      ok -> $target"
  } catch {
    Write-Host ("      FAILED (file in use?). Close dsh and retry: " + $_.Exception.Message) -ForegroundColor Red
  }
} else {
  Write-Host "      not installed"
}

# --------------------------------------------------------------------- 3. purge data
Write-Host "[3/3] data ..."
if ($PurgeData) {
  $db = Join-Path $env:USERPROFILE ".dsh-ebbinghaus\memory-shared.db"
  if (-not (Test-Path $db)) {
    Write-Host "      no database found, nothing to purge"
  } else {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
      $candidates = @("H:\node js\node.exe", (Join-Path $env:ProgramFiles "nodejs\node.exe"))
      foreach ($c in $candidates) { if (Test-Path $c) { $node = $c; break } }
    }
    if (-not $node) {
      Write-Host "      node not found; delete rows manually:" -ForegroundColor Yellow
      Write-Host ("      DELETE FROM memories WHERE source LIKE 'crossmem:%';  -- " + $db) -ForegroundColor Yellow
    } else {
      $exe = if ($node -is [string]) { $node } else { $node.Source }
      $script = @"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const before = db.prepare("SELECT COUNT(*) c FROM memories WHERE source LIKE 'crossmem:%'").get().c;
const info = db.prepare("DELETE FROM memories WHERE source LIKE 'crossmem:%'").run();
console.log('deleted ' + info.changes + ' rows (of ' + before + ')');
"@
      $tmp = Join-Path $env:TEMP "crossmem-purge.cjs"
      [System.IO.File]::WriteAllText($tmp, $script, (New-Object System.Text.UTF8Encoding($false)))
      & $exe $tmp $db
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
  }
} else {
  Write-Host "      kept (memories stay in memory-shared.db; use -PurgeData to delete them)"
}

Write-Host ""
Write-Host "Done. Quit dsh completely and start it again." -ForegroundColor Green
Write-Host "Rolled back = plugin not loaded. Memories are untouched unless you passed -PurgeData." -ForegroundColor DarkGray
Write-Host ""

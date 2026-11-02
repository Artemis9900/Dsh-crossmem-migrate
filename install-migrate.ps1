<#
.SYNOPSIS
  Install the dsh-crossmem migration bundle (core + QQ domain) on a new machine.

.DESCRIPTION
  This script does exactly four things:
    1) copies plugin\dsh-crossmem and plugin\dsh-crossmem-qq into the profile node_modules
    2) registers them in the profile package.json (dependencies + dsh.profile.bundles,
       written as UTF-8 without BOM)
    3) copies config\crossmem-state.json / qq-state.json into %USERPROFILE%\.dsh-crossmem
    4) optionally (-WithData) restores the two database snapshots (existing files are
       backed up first)

  It does NOT start or restart DSH, and it does NOT touch the QQ bridge config.json
  (that merge is printed at the end for you to do by hand).

  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1
  files as ANSI, so non-ASCII comments would break parsing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-migrate.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-migrate.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-migrate.ps1 -WithData
#>
[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'desktop',
  [string]$PackageRoot = '',
  [string]$QqBridgeDir = 'D:\deepseek memory',
  [switch]$WithData,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Resolve the bundle root: default to the directory holding this script.
if (-not $PackageRoot) { $PackageRoot = $PSScriptRoot }
if (-not $PackageRoot) { $PackageRoot = (Get-Location).Path }

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }

# ---------- preflight ----------
if (-not (Test-Path $PackageRoot)) { throw "Package directory not found: $PackageRoot" }

# Auto-detect the bundle root: some archives wrap everything in one extra folder,
# which would otherwise make plugin/ look missing.
function Test-BundleRoot([string]$dir) {
  return (Test-Path (Join-Path $dir 'plugin\dsh-crossmem\package.json')) -and
         (Test-Path (Join-Path $dir 'plugin\dsh-crossmem-qq\package.json'))
}
if (-not (Test-BundleRoot $PackageRoot)) {
  $cands = @(Get-ChildItem -Path $PackageRoot -Directory -ErrorAction SilentlyContinue |
             Where-Object { Test-BundleRoot $_.FullName })
  if ($cands.Count -eq 1) {
    Say "  note: bundle root auto-detected -> $($cands[0].FullName)" 'Yellow'
    $PackageRoot = $cands[0].FullName
  } else {
    throw "Bundle incomplete under: $PackageRoot (expected plugin\dsh-crossmem\package.json and plugin\dsh-crossmem-qq\package.json)"
  }
}

$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgFile = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgFile)) {
  throw "Profile not found: $pkgFile  (check DSH installation, or pass -DshHome / -Profile)"
}

$harnessHome = Split-Path $DshHome -Parent

Say "Package  : $PackageRoot"
Say "DSH home : $DshHome"
Say "Profile  : $Profile"
Say "Target   : $profileDir"
if ($DryRun) { Say "Mode     : DRY RUN (nothing will be written)" 'Yellow' }

$nodeModules = Join-Path $profileDir 'node_modules'
$ok = 0
$skip = 0

# ---------- 1) copy plugins ----------
Step 1 'Copy plugins into node_modules'
foreach ($p in 'dsh-crossmem', 'dsh-crossmem-qq') {
  $src = Join-Path $PackageRoot "plugin\$p"
  $dst = Join-Path $nodeModules $p
  if ($DryRun) { Say "  would copy  $src -> $dst" 'DarkGray'; $skip++; continue }
  if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null }
  if (Test-Path $dst) {
    $bak = "$dst.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item $dst $bak
    Say "  existing copy backed up to $bak" 'Yellow'
  }
  Copy-Item $src $dst -Recurse -Force
  Say "  ok  $dst"
  $ok++
}

# ---------- 2) register in profile package.json ----------
Step 2 'Update the profile package.json'
$raw = [System.IO.File]::ReadAllText($pkgFile)
$pkg = $raw | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }

foreach ($p in 'dsh-crossmem', 'dsh-crossmem-qq') {
  $dep = "file:./node_modules/$p"
  if ($pkg.dependencies.PSObject.Properties.Name -contains $p) {
    $pkg.dependencies.$p = $dep
  } else {
    $pkg.dependencies | Add-Member -NotePropertyName $p -NotePropertyValue $dep
  }
}

$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
$bundles = @($bundles | Where-Object { $_ -ne 'dsh-crossmem' -and $_ -ne 'dsh-crossmem-qq' })

# keep core before the QQ domain; place them right after dsh-ebbinghaus when present
$anchor = $bundles.Length
for ($i = 0; $i -lt $bundles.Length; $i++) {
  if ($bundles[$i] -eq 'dsh-ebbinghaus') { $anchor = $i + 1 }
}
$newBundles = @()
for ($i = 0; $i -lt $bundles.Length; $i++) {
  $newBundles += $bundles[$i]
  if (($i + 1) -eq $anchor) { $newBundles += 'dsh-crossmem'; $newBundles += 'dsh-crossmem-qq' }
}
if ($newBundles -notcontains 'dsh-crossmem') { $newBundles += 'dsh-crossmem'; $newBundles += 'dsh-crossmem-qq' }
$pkg.dsh.profile.bundles = $newBundles

if ($DryRun) {
  Say "  would set dependencies: dsh-crossmem, dsh-crossmem-qq = file:./node_modules/<name>" 'DarkGray'
  Say "  would set bundles     : $($newBundles -join ', ')" 'DarkGray'
  $skip++
} else {
  $json = $pkg | ConvertTo-Json -Depth 24
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  Copy-Item $pkgFile "$pkgFile.bak-install-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  [System.IO.File]::WriteAllText($pkgFile, $json + "`n", $utf8NoBom)
  Say "  ok  $pkgFile (original backed up)"
  Say "      bundles = $($newBundles -join ', ')"
  $ok++
}

# ---------- 3) state files ----------
Step 3 'Install state files (soft switches / linked groups / QQ pool)'
$stateDir = Join-Path $harnessHome '.dsh-crossmem'
if (-not $DryRun -and -not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }

$pairs = @(
  @{ src = 'crossmem-state.json'; dst = 'state.json';    desc = 'switches + linked groups' },
  @{ src = 'qq-state.json';       dst = 'qq-state.json'; desc = 'QQ pool (qqPool)' }
)
foreach ($pair in $pairs) {
  $src = Join-Path $PackageRoot "config\$($pair.src)"
  $dst = Join-Path $stateDir $pair.dst
  if (-not (Test-Path $src)) { Say "  skip  $($pair.src) (not in bundle)" 'Yellow'; continue }
  if ($DryRun) { Say "  would copy  $src -> $dst  [$($pair.desc)]" 'DarkGray'; $skip++; continue }
  if (Test-Path $dst) { Copy-Item $dst "$dst.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" }
  Copy-Item $src $dst -Force
  Say "  ok  $dst  [$($pair.desc)]"
  $ok++
}

# ---------- 4) databases (optional) ----------
Step 4 'Memory database snapshots'
if (-not $WithData) {
  Say '  skipped (no -WithData). The new machine starts with empty stores; rerun with -WithData to restore.' 'Yellow'
} else {
  $dbPairs = @(
    @{ src = 'memory-shared.db'; dst = (Join-Path $harnessHome '.dsh-ebbinghaus\memory-shared.db'); desc = 'long-term store' },
    @{ src = 'qq-memory.db';     dst = (Join-Path $QqBridgeDir 'state\qq-memory.db');                desc = 'QQ session memory' }
  )
  foreach ($pair in $dbPairs) {
    $src = Join-Path $PackageRoot "data\$($pair.src)"
    if (-not (Test-Path $src)) { Say "  skip  $($pair.src) (not in bundle)" 'Yellow'; continue }
    if ($DryRun) { Say "  would copy  $src -> $($pair.dst)" 'DarkGray'; $skip++; continue }
    $dstDir = Split-Path $pair.dst -Parent
    if (-not (Test-Path $dstDir)) { Say "  skip  $($pair.desc): target directory missing ($dstDir)" 'Yellow'; continue }
    if (Test-Path $pair.dst) {
      Copy-Item $pair.dst "$($pair.dst).bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Say "  existing database backed up: $($pair.dst).bak-*" 'Yellow'
    }
    Copy-Item $src $pair.dst -Force
    Say "  ok  $($pair.dst)  [$($pair.desc)]"
    $ok++
  }
}

# ---------- summary ----------
Say "`nDone: $ok written, $skip skipped." 'Green'
Say @'

Next steps (manual)
-------------------
1) Restart DSH so the bundles load:
     schtasks /run /tn "DSH-Restart"
   or fully quit the DSH client and open it again.

2) Only on the machine that runs the QQ bot: merge config\qqMemory.json into the
   bridge config.json:

     "qqMemory": {
       "dbPath": "D:\\deepseek memory\\state\\qq-memory.db",
       "ttlHours": 24,
       "ownerPrivate": ["private:<your QQ number>"]
     }

   then restart the bridge: D:\deepseek memory\restart.bat

3) Verify:
   - call crossmem_stats in any session: it should say "external domain: qq"
   - the settings page should show two sections: Cross-session memory + QQ memory library
   - linked groups (groups) are bound to DSH session ids: re-pick them in the panel
   - the QQ pool (qqPool) is keyed by group:/private: and is reused as is

Do NOT
------
- Do not copy config\qq-sessions.machine-specific.json over state\sessions.json.
  That is the old machine's session map; the bridge regenerates it on first start.
- Do not save package.json with a BOM. DSH fails to parse it and skips the bundle
  silently. This script writes UTF-8 without BOM on purpose.

'@ 'Cyan'

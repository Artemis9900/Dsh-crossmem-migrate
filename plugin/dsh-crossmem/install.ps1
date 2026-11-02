# Install dsh-crossmem into a dsh profile.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkipModelCheck      # 不检查本地模型
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Model "qwen2.5:3b"  # 指定要装的模型
# ASCII only in code strings: Windows PowerShell 5.1 reads .ps1 as ANSI.
param(
  [string]$Profile = "desktop",
  [string]$DshHome = "",
  [string]$Model = "modelscope.cn/Qwen/Qwen3-8B-GGUF:Q4_K_M",
  [switch]$SkipModelCheck,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:USERPROFILE ".dsh"
}
$profileDir = Join-Path (Join-Path $DshHome "profiles") $Profile
$target = Join-Path $profileDir "node_modules\dsh-crossmem"

Write-Host ""
Write-Host "=== dsh-crossmem installer ===" -ForegroundColor Cyan
Write-Host "dsh home : $DshHome"
Write-Host "profile  : $Profile"
Write-Host "source   : $src"
Write-Host "target   : $target"
Write-Host ""

if (-not (Test-Path $profileDir)) {
  Write-Host "ERROR: profile directory not found. Is dsh installed and has this profile been used?" -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- 1. copy files
Write-Host "[1/3] copying package ..."
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $src "*") $target -Recurse -Force
Remove-Item (Join-Path $target "install.ps1") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $target "test.mjs") -Force -ErrorAction SilentlyContinue
Write-Host "      ok -> $target"

# --------------------------------------------------------- 2. register in profile
Write-Host "[2/3] updating package.json ..."
$pkgFile = Join-Path $profileDir "package.json"
if (-not (Test-Path $pkgFile)) { Write-Host "ERROR: no package.json in profile" -ForegroundColor Red; exit 1 }

# Back up before touching it, so uninstall/rollback always has a known-good copy.
$backup = "$pkgFile.bak-install-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $pkgFile $backup -Force
Write-Host "      backup -> $backup"

$raw = [System.IO.File]::ReadAllText($pkgFile)
$pkg = $raw | ConvertFrom-Json

function Ensure-Prop($obj, $name) {
  # Empty pscustomobject can yield $null for Properties.Name, so wrap in @().
  if (@($obj.PSObject.Properties.Name) -notcontains $name) {
    $obj | Add-Member -NotePropertyName $name -NotePropertyValue ([pscustomobject]@{}) -Force
  }
}

Ensure-Prop $pkg "dependencies"
Ensure-Prop $pkg "dsh"
if (@($pkg.dsh.PSObject.Properties.Name) -notcontains "profile") {
  $pkg.dsh | Add-Member -NotePropertyName "profile" -NotePropertyValue ([pscustomobject]@{}) -Force
}
Ensure-Prop $pkg.dsh.profile "bundles"

$depValue = "file:./node_modules/dsh-crossmem"
if (@($pkg.dependencies.PSObject.Properties.Name) -contains "dsh-crossmem") {
  $pkg.dependencies."dsh-crossmem" = $depValue
} else {
  $pkg.dependencies | Add-Member -NotePropertyName "dsh-crossmem" -NotePropertyValue $depValue -Force
}

$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles += @($pkg.dsh.profile.bundles) }
if ($bundles -notcontains "dsh-crossmem") { $bundles += "dsh-crossmem" }
$pkg.dsh.profile.bundles = $bundles

# No BOM: dsh parses this file with JSON.parse and crashes on a leading BOM.
[System.IO.File]::WriteAllText($pkgFile, ($pkg | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "      ok -> bundled"
foreach ($b in $bundles) { Write-Host "        - $b" }

# ------------------------------------------------- 3. optional local model (Ollama)
Write-Host "[3/3] checking local model ..."

function Test-OllamaCli {
  $cmd = Get-Command ollama -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $guess = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
  if (Test-Path $guess) { return $guess }
  return $null
}

function Test-OllamaService {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 4
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Get-InstalledModels($exe) {
  try {
    $lines = & $exe list 2>$null
    $names = @()
    foreach ($line in ($lines | Select-Object -Skip 1)) {
      $t = ($line -split '\s+')[0]
      if ($t -and $t -ne "NAME") { $names += $t }
    }
    return $names
  } catch { return @() }
}

if ($SkipModelCheck) {
  Write-Host "      skipped (-SkipModelCheck)" -ForegroundColor DarkGray
} else {
  $cli = Test-OllamaCli
  $service = Test-OllamaService
  $models = @()
  if ($cli) { $models = Get-InstalledModels $cli }

  $hasModel = $false
  foreach ($m in $models) {
    if ($m -eq $Model) { $hasModel = $true; break }
  }

  Write-Host ("      ollama cli     : " + $(if ($cli) { $cli } else { "NOT FOUND" }))
  Write-Host ("      ollama service : " + $(if ($service) { "running" } else { "not running" }))
  Write-Host ("      models         : " + $(if ($models.Count) { ($models -join ", ") } else { "(none)" }))
  Write-Host ("      need           : " + $Model)

  if ($hasModel) {
    Write-Host "      ok, model is installed" -ForegroundColor Green
  } else {
    Write-Host ""
    Write-Host "  !! Local model NOT installed." -ForegroundColor Yellow
    Write-Host "     The plugin works without it: heuristic capture + prompt injection still run." -ForegroundColor DarkGray
    Write-Host "     The local model only adds smarter capture at session end (zero API cost)." -ForegroundColor DarkGray
    Write-Host ""

    if (-not $cli) {
      Write-Host "  Ollama is not installed either." -ForegroundColor Yellow
      Write-Host "  Install it from https://ollama.com/download , then run:" -ForegroundColor Yellow
      Write-Host ("      ollama pull " + $Model) -ForegroundColor Yellow
      Write-Host "  Re-run this installer afterwards, or just start using dsh now." -ForegroundColor Yellow
    } else {
      $answer = "n"
      if ($Yes) {
        $answer = "y"
      } else {
        $reply = Read-Host "  Install it now? (~5 GB download) [y/N]"
        if ($reply) { $answer = $reply.Trim().ToLower() }
      }

      if ($answer -eq "y" -or $answer -eq "yes") {
        Write-Host ""
        Write-Host ("  pulling " + $Model + " ...") -ForegroundColor Cyan
        Write-Host "  (this can take several minutes; Ctrl+C is safe — re-run later)" -ForegroundColor DarkGray
        try {
          & $cli pull $Model
          if ($LASTEXITCODE -eq 0) {
            Write-Host "  model installed" -ForegroundColor Green
          } else {
            Write-Host "  pull failed (exit $LASTEXITCODE). You can retry manually:" -ForegroundColor Red
            Write-Host ("      " + $cli + " pull " + $Model) -ForegroundColor Yellow
          }
        } catch {
          Write-Host ("  pull failed: " + $_.Exception.Message) -ForegroundColor Red
          Write-Host ("      " + $cli + " pull " + $Model) -ForegroundColor Yellow
        }
      } else {
        Write-Host "  skipped. To install later:" -ForegroundColor DarkGray
        Write-Host ("      " + $cli + " pull " + $Model) -ForegroundColor DarkGray
      }
    }
  }
}

# ------------------------------------------------------------------------- done
Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "Next: fully quit dsh (all DeepSeek Harness.exe) and start it again." -ForegroundColor Yellow
Write-Host "Verify: call crossmem_stats in any session." -ForegroundColor Yellow
Write-Host ""
Write-Host "Tip: without the local model the plugin still works; to silence it, set" -ForegroundColor DarkGray
Write-Host "     captureLocal: false in the dsh-crossmem config." -ForegroundColor DarkGray

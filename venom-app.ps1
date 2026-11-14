# VENOM as a desktop app.
#
# Starts the brain (bridge) and the face (Vite) hidden in the background, opens
# Venom in its own Chrome app window (no tabs, no address bar) with a separate
# Chrome profile, full screen (F11 leaves full screen; set VENOM_WINDOWED=1 for
# a normal 1400x850 window), and stops the background servers again when that
# window is closed. Run through Venom.vbs so no console window appears.
#
# Why Chrome and not a fully native shell: the voice loop uses Chrome's speech
# recognition and Google voices, which exist only inside Chrome. The separate
# profile keeps Venom's recogniser from colliding with your normal Chrome tabs.

$ErrorActionPreference = 'Stop'
$root    = $PSScriptRoot
$chrome  = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$appData = Join-Path $env:USERPROFILE '.venom'
$appProfile = Join-Path $appData 'chrome-app'
$logDir  = Join-Path $appData 'logs'
$url     = 'http://localhost:5173'
New-Item -ItemType Directory -Force $appProfile, $logDir | Out-Null

function Test-Port([int]$port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

$servers = $null
if (-not (Test-Port 8787)) {
  # Use your own Claude login, not settings inherited from another app.
  Get-ChildItem env: | Where-Object { $_.Name -match '^(ANTHROPIC|CLAUDE)' -or $_.Name -eq 'CLAUDECODE' } |
    ForEach-Object { Remove-Item "env:$($_.Name)" }
  # The voice app model: VENOM_MODEL if already set, else appModel in
  # venom.config.json, else Claude Code's own default (bridge/settings.mjs).
  if (-not $env:VENOM_MCP_SERVERS) {
    $env:VENOM_MCP_SERVERS = 'hermes,context7,firecrawl,sequential-thinking'
  }

  # Read-only by default. Set VENOM_ALLOW_WRITES=1 (for example as a user
  # environment variable) to let VENOM act; the bridge reads it directly.
  $log = Join-Path $logDir 'venom.log'
  $servers = Start-Process -FilePath 'node' -ArgumentList 'scripts/start.mjs' `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"

  # Wait (up to 30 s) for both the face and the brain to be listening.
  for ($i = 0; $i -lt 60 -and -not ((Test-Port 5173) -and (Test-Port 8787)); $i++) {
    Start-Sleep -Milliseconds 500
  }
}

# Google Chrome only, never Edge. A separate profile directory makes this its own
# Chrome process, so waiting on it means waiting for the Venom window to close.
# Full screen by default; VENOM_WINDOWED=1 gives the old fixed-size window.
$windowArg = if ($env:VENOM_WINDOWED -eq '1') { '--window-size=1400,850' } else { '--start-fullscreen' }
$app = Start-Process -FilePath $chrome -PassThru -ArgumentList @(
  "--user-data-dir=`"$appProfile`"",
  "--app=$url",
  $windowArg,
  '--no-first-run',
  '--no-default-browser-check'
)
$app.WaitForExit()

# Only stop servers this launcher started; if they were already running (for
# example from Venom.cmd in a terminal), leave them alone.
if ($servers -and -not $servers.HasExited) {
  & taskkill.exe /PID $servers.Id /T /F | Out-Null
}

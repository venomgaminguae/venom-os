#Requires -Version 7.0
<#
.SYNOPSIS
  Creates the Venom OS agent team as Hermes profiles: a supervisor (default
  name venom) and the starter specialists you choose from researcher, coder,
  operator, writer (default: all four). Safe to run again. More agents are
  added later with `npm run add-agent`.

.DESCRIPTION
  `npm run setup` runs this script for you with the values you chose. Run it
  by hand to set the models yourself.

  On screen it prints one line per profile and one for the team connector.
  The full output (every hermes command and its output) is appended to the
  -Log file, or to a new file in the system temp folder; its path is the last
  line. A failing command and its output are always shown on screen.

  For each profile (the supervisor, then the chosen specialists) it:
    1. creates it with `hermes profile create <name> --description ...`
       (skipped when `hermes profile show <name>` finds it). The
       specialists are created with `--clone-from <supervisor>`, so an API key
       in the supervisor's .env carries over (account sign-ins do not),
    2. copies souls/<template>.SOUL.md to the profile's SOUL.md, filling in the
       {{...}} placeholders (the supervisor always uses souls/venom.SOUL.md; an
       existing, different SOUL.md is kept as SOUL.md.bak-<timestamp>, except
       in a profile this run has just created),
    3. sets the brain and worker models with `hermes -p <name> config set`,
    4. for a specialist, removes a `team` connector it may have copied from
       the supervisor (a specialist that can call the team can start loops).
  Then, with -RepoPath, it registers the team connector on the supervisor
  (`hermes -p <supervisor> mcp add team ...`), unless `mcp list` already shows it.
  The specialists always exist before that step.

  It never touches credentials: sign in to your provider with
  `hermes -p <name> model` yourself.

.PARAMETER Supervisor
  Name of the supervisor profile. Default: venom.
.PARAMETER Agents
  Starter specialists to create, comma-separated, in any order, each once:
  a subset of researcher,coder,operator,writer. Default: all four.
.PARAMETER BrainModel
  Model id every agent runs on, exactly as `hermes model` shows it. Required.
.PARAMETER BrainProvider
  Provider of the brain model, as `hermes model` shows it. Required.
.PARAMETER WorkerModel
  Model for the agents' workers (delegate_task subagents). Default: the brain model.
.PARAMETER WorkerProvider
  Provider of the worker model. Default: the brain provider.
.PARAMETER MaxWorkers
  Workers that may run in parallel per agent. Default: 5.
.PARAMETER RepoPath
  Absolute path of the Venom OS repository; enables the team connector step.
.PARAMETER CloneFrom
  Profile the new specialists are cloned from. Default: the supervisor.
  'none' creates them empty. Given explicitly, a missing supervisor is cloned
  from it too.
.PARAMETER NoAlias
  Pass --no-alias to `hermes profile create` (no per-profile command is written).
.PARAMETER Log
  File the full output is appended to. Default: a new file in the system temp folder.
.PARAMETER ShowCommands
  Print the full output (every hermes command and its output) on screen too.
.PARAMETER NoNext
  Leave out the closing "Next: sign in ..." line (npm run setup does those
  checks itself).
.PARAMETER WhatIf
  Dry run: print every command and file copy, run nothing, call no hermes command.

.EXAMPLE
  pwsh -File create-profiles.ps1 -BrainModel <MODEL_ID> -BrainProvider <PROVIDER> -WhatIf
  pwsh -File create-profiles.ps1 -Supervisor boss -Agents researcher,writer -BrainModel <MODEL_ID> -BrainProvider <PROVIDER> -WorkerModel <CHEAPER_MODEL_ID> -RepoPath C:/code/venom-os
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Supervisor = 'venom',
    [string[]]$Agents = @('researcher,coder,operator,writer'),
    [string]$BrainModel = '<BRAIN_MODEL>',
    [string]$BrainProvider = '<BRAIN_PROVIDER>',
    [string]$WorkerModel = '',
    [string]$WorkerProvider = '',
    [int]$MaxWorkers = 5,
    [string]$RepoPath = '',
    [string]$CloneFrom = '',
    [switch]$NoAlias,
    [string]$Log = '',
    [switch]$ShowCommands,
    [switch]$NoNext,
    # Filled into the SOUL templates. Optional; these defaults are fine.
    [string]$Browser = 'your default web browser',
    [string]$NotesDir = '~/venom-notes',
    [string]$Market = 'your own country, in its currency'
)

$ErrorActionPreference = 'Stop'
$DryRun = [bool]$WhatIfPreference
# The steps below decide themselves what to run; keep cmdlets from also
# honouring -WhatIf (Copy-Item would otherwise print its own messages).
$WhatIfPreference = $false

if (-not $WorkerModel) { $WorkerModel = $BrainModel }
if (-not $WorkerProvider) { $WorkerProvider = $BrainProvider }

$AllSpecialists = [ordered]@{
    researcher = 'Web research: finds, compares and verifies information, products, prices and sources, and reports with links.'
    coder      = 'Software: writes, fixes, reviews and runs code and scripts, and verifies the result works.'
    operator   = 'This computer: files and folders, documents, spreadsheets, PDFs, installs and routine tasks.'
    writer     = 'Writing: drafts emails, posts, product descriptions, documents and replies. Drafts only, never sends.'
}
$SupervisorDescription = 'Supervisor: plans, delegates to the specialist agents through the team connector, checks their reports and answers the owner.'

# -Agents: a subset of the four, any order, each once, no empty entries.
# Accepts "coder,writer" (one string, as `pwsh -File` passes it) and coder,writer
# (an array, as PowerShell itself passes it). Created in the usual order.
$agentItems = @(@($Agents) | ForEach-Object { ([string]$_) -split ',' } | ForEach-Object { $_.Trim() })
$chosen = @()
foreach ($item in $agentItems) {
    if (-not $item) {
        Write-Error '-Agents needs one or more of researcher, coder, operator, writer, separated by commas, with no empty entries.' -ErrorAction Continue
        exit 64
    }
    if (-not $AllSpecialists.Contains($item) -or $item -cnotmatch '^[a-z]+$') {
        Write-Error "-Agents: unknown agent '$item'; choose from researcher, coder, operator, writer, separated by commas." -ErrorAction Continue
        exit 64
    }
    if ($chosen -ccontains $item) {
        Write-Error "-Agents: '$item' is listed more than once." -ErrorAction Continue
        exit 64
    }
    $chosen += $item
}
if ($chosen.Count -eq 0) {
    Write-Error '-Agents needs one or more of researcher, coder, operator, writer, separated by commas, with no empty entries.' -ErrorAction Continue
    exit 64
}
$Specialists = [ordered]@{}
foreach ($k in $AllSpecialists.Keys) { if ($chosen -ccontains $k) { $Specialists[$k] = $AllSpecialists[$k] } }

if ($Supervisor -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$' -or $AllSpecialists.Contains($Supervisor) -or $Supervisor -in @('default', 'hermes', 'test', 'tmp', 'root', 'sudo')) {
    Write-Error "-Supervisor '$Supervisor' is not usable: lowercase letters, digits, - and _, and not one of the specialist names (researcher, coder, operator, writer) or a name Hermes reserves." -ErrorAction Continue
    exit 2
}

# Profile name -> description, SOUL template. The supervisor comes first, so
# the specialists can be cloned from it.
$Profiles = [ordered]@{}
$Profiles[$Supervisor] = @{ Description = $SupervisorDescription; Soul = 'venom'; Specialist = $false }
foreach ($k in $Specialists.Keys) { $Profiles[$k] = @{ Description = $Specialists[$k]; Soul = $k; Specialist = $true } }

$SoulDir = Join-Path $PSScriptRoot 'souls'

function Test-Placeholder([string]$Value) { return (-not $Value) -or ($Value -match '^<.*>$') }

$unset = @()
foreach ($pair in @(@('BrainModel', $BrainModel), @('BrainProvider', $BrainProvider), @('WorkerModel', $WorkerModel), @('WorkerProvider', $WorkerProvider))) {
    if (Test-Placeholder $pair[1]) { $unset += '-' + $pair[0] }
}
if ($unset.Count -gt 0) {
    $msg = "Still placeholders: $($unset -join ', '). Pass them as parameters (model ids and provider names as 'hermes model' shows them), or run 'npm run setup'."
    if (-not $DryRun) { Write-Error $msg -ErrorAction Continue; exit 2 }
    Write-Warning "$msg Dry run continues with the placeholders."
}

function Resolve-Hermes {
    if ($env:HERMES_EXE) { return $env:HERMES_EXE }
    $cmd = Get-Command hermes -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if ($env:LOCALAPPDATA) {
        $p = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
        if (Test-Path $p) { return $p }
    }
    return $null
}

$Hermes = Resolve-Hermes
if (-not $Hermes) {
    if (-not $DryRun) { Write-Error 'Hermes not found. Install it first (see README.md), open a new terminal, or set $env:HERMES_EXE.' -ErrorAction Continue; exit 3 }
    $Hermes = 'hermes'
}

# Output: Write-Say lines always reach the screen; Write-Detail lines (the
# commands, their output and the file steps, as -ShowCommands prints them) go
# to the log, and to the screen with -ShowCommands or -WhatIf. A dry run
# writes a log only when -Log is given.
$OnScreen = [bool]$ShowCommands -or $DryRun
$LogPath = $Log
if (-not $LogPath -and -not $DryRun) {
    $LogPath = Join-Path ([System.IO.Path]::GetTempPath()) ('venom-create-profiles-' + [System.IO.Path]::GetRandomFileName() + '.log')
}
if ($LogPath) {
    try {
        [System.IO.File]::AppendAllText($LogPath, '', [System.Text.UTF8Encoding]::new($false))
        $LogPath = (Resolve-Path -LiteralPath $LogPath).Path
    } catch {
        Write-Error "Cannot write the log file $LogPath" -ErrorAction Continue
        exit 64
    }
}

function Write-ToLog([string]$Line) {
    if ($LogPath) { [System.IO.File]::AppendAllText($LogPath, $Line + "`n", [System.Text.UTF8Encoding]::new($false)) }
}
function Write-Say([string]$Line) { Write-Host $Line; Write-ToLog $Line }
function Write-Detail([string]$Line) { Write-ToLog $Line; if ($OnScreen) { Write-Host $Line } }

function Format-Cmd([string[]]$CmdArgs) {
    ($CmdArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

function Invoke-Hermes([string[]]$CmdArgs) {
    $cmd = '> hermes ' + (Format-Cmd $CmdArgs)
    Write-Detail $cmd
    if ($DryRun) { return }
    # Native stderr lines must not turn into terminating errors here.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = @(& $Hermes @CmdArgs 2>&1 | ForEach-Object { ([string]$_).TrimEnd("`r") })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    $text = $out -join "`n"
    if ($text) { Write-Detail $text }
    if ($code -ne 0) {
        # Quiet mode: the failing command and its output still reach the screen.
        if (-not $OnScreen) {
            Write-Host $cmd
            if ($text) { Write-Host $text }
        }
        Write-ToLog "ERROR: that command failed with exit code $code."
        throw "That command failed with exit code $code."
    }
}

function Test-HermesQuiet([string[]]$CmdArgs) {
    & $Hermes @CmdArgs *> $null
    return ($LASTEXITCODE -eq 0)
}

function Test-HasTeam([string]$Name) {
    $list = (& $Hermes -p $Name mcp list 2>&1) -join "`n"
    return ($list -match '(?m)^\s*team\s')
}

function Get-ProfileDir([string]$Name) {
    $path = (& $Hermes -p $Name config path 2>$null | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or -not $path) { throw "Could not find the folder of profile '$Name' (hermes -p $Name config path)." }
    return (Split-Path -Parent $path.Trim())
}

function Expand-Soul([string]$Text) {
    $Text.Replace('{{BRAIN_MODEL}}', $BrainModel).
        Replace('{{WORKER_MODEL}}', $WorkerModel).
        Replace('{{MAX_WORKERS}}', [string]$MaxWorkers).
        Replace('{{BROWSER}}', $Browser).
        Replace('{{NOTES_DIR}}', $NotesDir).
        Replace('{{MARKET}}', $Market)
}

function Get-CreateArgs([string]$Name, $Info) {
    $a = @('profile', 'create', $Name)
    $src = ''
    if ($Info.Specialist) {
        if ($CloneFrom -ne 'none') { $src = if ($CloneFrom) { $CloneFrom } else { $Supervisor } }
    } elseif ($CloneFrom -and $CloneFrom -ne 'none' -and $CloneFrom -ne $Name) {
        $src = $CloneFrom
    }
    if ($src) { $a += @('--clone-from', $src) }
    $a += @('--description', $Info.Description)
    if ($NoAlias) { $a += '--no-alias' }
    return , $a
}

try {
    if ($DryRun) { Write-Say '# Dry run (-WhatIf): nothing is created or changed.' }
    Write-Say "# Supervisor: $Supervisor. Agents: $(@($Specialists.Keys) -join ' '). Brain: $BrainProvider/$BrainModel. Workers: $WorkerProvider/$WorkerModel (up to $MaxWorkers)."

    foreach ($name in $Profiles.Keys) {
        $info = $Profiles[$name]
        Write-Detail ''
        Write-Detail "## $name"
        $steps = @()

        # 1. Profile
        $created = $false
        $createArgs = Get-CreateArgs $name $info
        if ($DryRun) {
            Write-Detail "# skipped if 'hermes profile show $name' succeeds"
            Invoke-Hermes $createArgs
        } elseif (Test-HermesQuiet @('profile', 'show', $name)) {
            Write-Detail "profile '$name' exists, not recreated"
            $steps += 'exists'
        } else {
            Invoke-Hermes $createArgs
            $created = $true
            $steps += 'created'
        }

        # 2. SOUL.md
        $src = Join-Path $SoulDir "$($info.Soul).SOUL.md"
        if (-not (Test-Path $src)) { throw "Missing template $src" }
        if ($DryRun) {
            Write-Detail "> copy $src -> <folder of 'hermes -p $name config path'>/SOUL.md (placeholders filled, a different existing SOUL.md backed up)"
        } else {
            $dest = Join-Path (Get-ProfileDir $name) 'SOUL.md'
            $soul = Expand-Soul (Get-Content -Raw -Encoding utf8 $src)
            $bak = ''
            if (Test-Path $dest) {
                $current = Get-Content -Raw -Encoding utf8 $dest
                if ($current -ceq $soul) {
                    Write-Detail 'SOUL.md already up to date'
                    $steps += 'job brief up to date'
                } elseif (-not $created) {
                    $bak = "$dest.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
                    Copy-Item -LiteralPath $dest -Destination $bak
                    Write-Detail "kept the previous SOUL.md as $bak"
                }
            }
            if (-not (Test-Path $dest) -or ((Get-Content -Raw -Encoding utf8 $dest) -cne $soul)) {
                [System.IO.File]::WriteAllText($dest, $soul, [System.Text.UTF8Encoding]::new($false))
                Write-Detail "wrote $dest"
                if ($bak) { $steps += "job brief updated (previous one kept as $(Split-Path -Leaf $bak))" } else { $steps += 'job brief written' }
            }
        }

        # 3. Models (config set is idempotent)
        Invoke-Hermes @('-p', $name, 'config', 'set', 'model.default', $BrainModel)
        Invoke-Hermes @('-p', $name, 'config', 'set', 'model.provider', $BrainProvider)
        Invoke-Hermes @('-p', $name, 'config', 'set', 'delegation.model', $WorkerModel)
        Invoke-Hermes @('-p', $name, 'config', 'set', 'delegation.provider', $WorkerProvider)
        Invoke-Hermes @('-p', $name, 'config', 'set', 'delegation.oneshot_max_children', [string]$MaxWorkers)
        $steps += 'models set'

        # 4. No team connector on a specialist
        if ($info.Specialist) {
            if ($DryRun) {
                Write-Detail "# only if 'hermes -p $name mcp list' lists 'team' (copied from the supervisor)"
                Invoke-Hermes @('-p', $name, 'mcp', 'remove', 'team')
            } elseif (Test-HasTeam $name) {
                Invoke-Hermes @('-p', $name, 'mcp', 'remove', 'team')
                $steps += 'copied team connector removed'
            }
        }

        if (-not $DryRun) { Write-Say "${name}: $($steps -join ', ')" }
    }

    # 5. Team connector on the supervisor only, after every specialist exists
    Write-Detail ''
    Write-Detail "## team connector ($Supervisor profile)"
    if (-not $RepoPath) {
        Write-Detail '# skipped: pass -RepoPath <path of the Venom OS repo> to register it'
        if (-not $DryRun) { Write-Say 'team connector: skipped (pass -RepoPath <path of the Venom OS repo> to register it)' }
    } else {
        $server = (Join-Path $RepoPath 'hermes-mcp/server.mjs') -replace '\\', '/'
        if (-not $DryRun -and -not (Test-Path $server)) { throw "Not found: $server" }
        if ($DryRun) {
            Write-Detail "# skipped if 'hermes -p $Supervisor mcp list' already lists 'team'"
            Invoke-Hermes @('-p', $Supervisor, 'mcp', 'add', 'team', '--command', 'node', '--args', $server)
        } elseif (Test-HasTeam $Supervisor) {
            Write-Detail "'team' already registered on $Supervisor"
            Write-Say "team connector: already registered on $Supervisor"
        } else {
            Invoke-Hermes @('-p', $Supervisor, 'mcp', 'add', 'team', '--command', 'node', '--args', $server)
            Write-Say "team connector: registered on $Supervisor"
        }
    }

    Write-Detail ''
    if (-not $NoNext) { Write-Say 'Next: sign in to your provider for each profile if needed (hermes -p <name> model), then verify (README.md, "Verify").' }
} catch {
    Write-ToLog "ERROR: $($_.Exception.Message)"
    throw
} finally {
    if ($LogPath) { Write-Host "Full output: $LogPath" }
}

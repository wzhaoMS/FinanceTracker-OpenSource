<#
.SYNOPSIS
  Starts the Holdr card sync receiver (experimental) whenever you sign in to Windows: as you, without administrator rights.

.DESCRIPTION
  Registers a Task Scheduler task for the current user only. At logon it runs the receiver with Node.js in a hidden
  PowerShell window (a window may flash briefly at sign-in), restarts it up to three times if it fails, and never runs a
  second copy. The receiver listens on 127.0.0.1 only and writes its log to <Imports>\receiver.log. Unless -NoStart is
  given, it first stops a receiver that is already running (with stop-receiver.ps1), then starts the new one.

  Run from any folder:
    powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\register-task.ps1
  Stop the receiver with stop-receiver.ps1, and remove the task with unregister-task.ps1, in the same folder.

.PARAMETER NodePath
  Full path of node.exe (default: the node on your PATH).
.PARAMETER Imports
  The private imports folder (default: %USERPROFILE%\Holdr\imports).
.PARAMETER DataDir
  Holdr's data folder, only if you start Holdr with --data-dir or HOLDR_DATA_DIR. Without it the receiver finds the folder
  itself, as `npm run agent` does: the npm run start:local folder (%LOCALAPPDATA%\Holdr\data) once Holdr has created its
  service-token file there, otherwise apps\api\data in this checkout (where npm run dev keeps it).
.PARAMETER WebUrl
  The Holdr address that "Open Holdr" opens (default: http://127.0.0.1:5173). If you start Holdr with --https-origin, give
  that address, such as https://<machine>.<tailnet>.ts.net: Holdr then refuses sign-in at http://127.0.0.1:5173.
.PARAMETER AppUrl
  Holdr's API on this computer (default: http://127.0.0.1:4000).
.PARAMETER Port
  The receiver's port on 127.0.0.1 (default: 4401).
.PARAMETER DefinitionOnly
  Print the task definition (XML) and register nothing.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Holdr Card Sync',
  [string]$NodePath = '',
  [string]$Imports = (Join-Path $env:USERPROFILE 'Holdr\imports'),
  [string]$DataDir = '',
  [string]$AppUrl = '',
  [string]$WebUrl = '',
  [int]$Port = 0,
  [switch]$DefinitionOnly,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..\..')).Path
$receiver = Join-Path $repo 'agents\card-sync\receiver.mjs'
if (-not (Test-Path -LiteralPath $receiver -PathType Leaf)) { throw "receiver.mjs was not found under $repo" }
if (-not $NodePath) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if (-not $found) { throw 'node.exe is not on PATH: install Node.js 22 LTS, or pass -NodePath with the full path of node.exe' }
  $NodePath = $found.Source
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or [IO.Path]::GetFileName($NodePath) -ne 'node.exe') {
  throw 'Pass -NodePath with the full path of node.exe'
}
foreach ($value in @($NodePath, $Imports, $DataDir, $AppUrl, $WebUrl)) {
  if ($value -match '["\r\n]') { throw 'Paths and addresses must not contain double quotes or line breaks.' }
}
if (-not [IO.Path]::IsPathRooted($Imports) -or ($DataDir -and -not [IO.Path]::IsPathRooted($DataDir))) {
  throw '-Imports and -DataDir must be full paths.'
}

# One PowerShell command line: every value single-quoted, so nothing in a path is expanded. Every character PowerShell
# reads as a single quote (the ASCII one and the typographic ones, U+2018 to U+201B) is doubled inside, so no folder name
# can end the string.
function Format-Literal([string]$value) {
  "'" + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($value) + "'"
}
# A folder without its trailing backslash: Windows PowerShell 5.1 hands node a value with spaces in double quotes, and a
# backslash before the closing quote would escape it and run the arguments together. A drive root keeps it (D:\).
function Format-Folder([string]$value) {
  $trimmed = $value.TrimEnd('\')
  if ($trimmed -match '^[A-Za-z]:$' -or $trimmed -eq '') { $trimmed = $value }
  Format-Literal $trimmed
}
$receiverArgs = @((Format-Literal $receiver), '--imports', (Format-Folder $Imports), '--log-file', (Format-Literal (Join-Path $Imports 'receiver.log')))
if ($DataDir) { $receiverArgs += @('--data-dir', (Format-Folder $DataDir)) }
if ($AppUrl) { $receiverArgs += @('--app-url', (Format-Literal $AppUrl)) }
if ($WebUrl) { $receiverArgs += @('--web-url', (Format-Literal $WebUrl)) }
if ($Port) { $receiverArgs += @('--port', [string]$Port) }
$command = '& ' + (Format-Literal $NodePath) + ' ' + ($receiverArgs -join ' ')
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $powershell -WorkingDirectory $repo `
  -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $command + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Holdr card sync receiver (experimental): listens on 127.0.0.1 for the Holdr Card Sync browser extension.'

if ($DefinitionOnly) {
  Export-ScheduledTask -InputObject $task
  return
}
# A receiver that is still running (an earlier registration's, or one started by hand) would keep the port, and the task
# ignores a start while its previous run lasts: stop it first, so that the receiver from this checkout starts.
if (-not $NoStart) { & (Join-Path $PSScriptRoot 'stop-receiver.ps1') -TaskName $TaskName }
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -InputObject $task -Force | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $TaskName -TaskPath '\' }
Write-Host "Registered the task '$TaskName' for $user. The receiver starts at every sign-in$(if (-not $NoStart) { ' and is starting now' })."
Write-Host "Log: $(Join-Path $Imports 'receiver.log')"
Write-Host 'Check it with: npm run agent -- check   Stop it with: stop-receiver.ps1   Remove it with: unregister-task.ps1'

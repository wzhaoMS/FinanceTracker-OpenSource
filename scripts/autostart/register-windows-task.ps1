<#
.SYNOPSIS
  Starts Holdr (npm run start:local) whenever you sign in to Windows: as you, without administrator rights.

.DESCRIPTION
  Registers a Task Scheduler task for the current user only. At sign-in it runs `npm run start:local` in this
  checkout in its own console window (press Ctrl+C there, or close the window, to stop Holdr), restarts it up to three
  times if it fails, and never runs a second copy. Output goes to %LOCALAPPDATA%\Holdr\logs\holdr.log.

  Run from the repository folder:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart\register-windows-task.ps1
  Remove the task again:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart\register-windows-task.ps1 -Unregister

.PARAMETER Arguments
  Extra arguments for start:local, e.g. '--https-origin https://holdr.example.ts.net'.
.PARAMETER DefinitionOnly
  Print the task definition (XML) and register nothing.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Holdr',
  [string]$Arguments = '',
  [switch]$Unregister,
  [switch]$DefinitionOnly,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
  Write-Host "Removed the task '$TaskName'. A Holdr that is running now keeps running until you stop it (Ctrl+C in its window, or close it)."
  return
}

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $repo 'scripts\start-local.mjs') -PathType Leaf)) { throw "scripts\start-local.mjs was not found under $repo" }
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { throw 'npm is not on PATH: install Node.js 22 LTS first' }
foreach ($value in @($repo, $npm.Source, $Arguments)) {
  if ($value -match '["\r\n%^&|<>]') { throw 'The repository path, npm path and arguments must not contain quotes, line breaks or the characters % ^ & | < >.' }
}
$logDir = Join-Path $env:LOCALAPPDATA 'Holdr\logs'

$command = '"' + $npm.Source + '" run start:local' + $(if ($Arguments) { ' -- ' + $Arguments } else { '' }) + ' >> "' + (Join-Path $logDir 'holdr.log') + '" 2>&1'
$cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $cmd -Argument ('/d /c "' + $command + '"') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Holdr: npm run start:local at sign-in (API and web app on 127.0.0.1 only).'

if ($DefinitionOnly) {
  Export-ScheduledTask -InputObject $task
  return
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -InputObject $task -Force | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $TaskName -TaskPath '\' }
Write-Host "Registered the task '$TaskName' for $user. Holdr starts at every sign-in$(if (-not $NoStart) { ' and is starting now' })."
Write-Host "Log: $(Join-Path $logDir 'holdr.log')"
Write-Host 'Remove it with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart\register-windows-task.ps1 -Unregister'

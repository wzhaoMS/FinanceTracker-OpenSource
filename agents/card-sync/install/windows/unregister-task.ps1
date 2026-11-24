<#
.SYNOPSIS
  Removes the Holdr card sync auto-start task (experimental) and stops the receiver.

.DESCRIPTION
  Stops the receiver first with stop-receiver.ps1 (the task's current run, then every node.exe of the current user
  running agents\card-sync\receiver.mjs, including one started by hand), then unregisters the current user's task.
  Needs no administrator rights.
    powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\unregister-task.ps1
#>
[CmdletBinding()]
param([string]$TaskName = 'Holdr Card Sync')
$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'stop-receiver.ps1') -TaskName $TaskName

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
  Write-Host "Removed the task '$TaskName'."
} else {
  Write-Host "There is no task named '$TaskName'."
}

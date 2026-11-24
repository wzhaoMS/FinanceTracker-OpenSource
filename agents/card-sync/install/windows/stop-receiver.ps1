<#
.SYNOPSIS
  Stops the Holdr card sync receiver (experimental): the auto-start task's current run, and any receiver started by hand.

.DESCRIPTION
  Stopping the scheduled task alone (Stop-ScheduledTask, or End in Task Scheduler) ends only its hidden PowerShell
  window: the node.exe it started keeps running and keeps the receiver's port, so a new receiver cannot start. This
  script stops the task's current run first, then every node.exe of the current user whose command line runs
  agents\card-sync\receiver.mjs, and waits until they have exited. The task stays registered: it starts the receiver
  again at the next sign-in, or now with Start-ScheduledTask. Needs no administrator rights.
    powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\stop-receiver.ps1

.PARAMETER TaskName
  The auto-start task's name (default: Holdr Card Sync).
.PARAMETER CommandLinePattern
  A regular expression that a receiver's command line matches (default: agents\card-sync\receiver.mjs, either slash).
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Holdr Card Sync',
  [string]$CommandLinePattern = 'agents[\\/]card-sync[\\/]receiver\.mjs'
)
$ErrorActionPreference = 'Stop'

# The task's run first: a receiver stopped while its task still runs would count as a failure, and the task would
# start it again.
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName -TaskPath '\'
  Write-Host "Stopped the task '$TaskName'."
}

# Then the receivers themselves, which outlive the task's PowerShell window: only the current user's.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Test-OwnProcess($process) {
  $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
  return ($null -ne $owner) -and ($owner.ReturnValue -eq 0) -and ($owner.Sid -eq $me)
}
$receivers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match $CommandLinePattern -and (Test-OwnProcess $_) })
if ($receivers.Count -eq 0) {
  Write-Host 'No receiver was running.'
  return
}
foreach ($process in $receivers) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped the receiver (process $($process.ProcessId))."
}
# Wait until they have exited, so that the port is free for the next receiver.
$ids = @($receivers | ForEach-Object { [int]$_.ProcessId })
Wait-Process -Id $ids -Timeout 15 -ErrorAction SilentlyContinue
$left = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
if ($left.Count -gt 0) { throw "The receiver (process $($left[0])) did not stop; end it in Task Manager (Details, node.exe)." }

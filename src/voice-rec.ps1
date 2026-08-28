# voice-rec.ps1 — скрытый рекордер для toggle-режима: пишет ffmpeg, завершается
# по появлению файла-флага, играет бипы на старт/стоп.
param(
    [string]$Wav,
    [string]$StopFlag
)
$ErrorActionPreference = 'Stop'

$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
}
if (-not $ff) { exit 1 }

if (-not $Wav) { exit 1 }
if (-not $StopFlag) { $StopFlag = Join-Path $env:TEMP 'voice-rec.stop' }
Remove-Item $StopFlag -ErrorAction SilentlyContinue

$Device = $null
$ConfigPath = "$env:USERPROFILE\.voice\config.json"
if (Test-Path $ConfigPath) {
    $Device = (Get-Content -Raw $ConfigPath | ConvertFrom-Json).device
}
if (-not $Device) { exit 1 }

$psi = [System.Diagnostics.ProcessStartInfo]@{
    FileName               = $ff.Source
    Arguments              = "-y -hide_banner -loglevel error -f dshow -i `"audio=$Device`" -t 300 -ar 16000 -ac 1 `"$Wav`""
    RedirectStandardInput  = $true
    UseShellExecute        = $false
}

[console]::beep(880, 100)
$p = [System.Diagnostics.Process]::Start($psi)
while (-not $p.HasExited) {
    if (Test-Path $StopFlag) { $p.StandardInput.Write('q'); break }
    Start-Sleep -Milliseconds 100
}
if (-not $p.WaitForExit(3000)) { $p.Kill() }
[console]::beep(440, 140)
Remove-Item $StopFlag -ErrorAction SilentlyContinue

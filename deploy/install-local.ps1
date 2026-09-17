[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$watcherPath = Join-Path $PSScriptRoot 'watch-local.ps1'
$serverPath = Join-Path $checkout 'scripts\serve.mjs'
$stateRoot = Join-Path $env:LOCALAPPDATA 'OpenWysiwyg'
$releaseRoot = Join-Path $stateRoot 'releases'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Stop-LocalEditor {
    # Match this checkout's complete script paths. Never stop an unrelated port owner.
    $watcherArgument = '(?i)(?:^|\s)-File\s+(?:"' + [regex]::Escape($watcherPath) + '"|' + [regex]::Escape($watcherPath) + ')(?:\s|$)'
    $serverArgument = '(?i)^\s*(?:"[^"]*node\.exe"|\S*node(?:\.exe)?)\s+(?:"' + [regex]::Escape($serverPath) + '"|' + [regex]::Escape($serverPath) + ')(?:\s|$)'
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -and (
            ($_.Name -in @('powershell.exe', 'pwsh.exe') -and $_.CommandLine -match $watcherArgument -and $_.CommandLine -notmatch '(?i)(?:^|\s)-(Command|EncodedCommand|c|e)\b') -or
            ($_.Name -eq 'node.exe' -and $_.CommandLine -match $serverArgument)
        )
    } | Sort-Object @{Expression = { if ($_.Name -eq 'node.exe') { 1 } else { 0 } }})
    foreach ($process in $processes) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
}

$existingRun = (Get-ItemProperty -Path $runKey -Name OpenWysiwyg -ErrorAction SilentlyContinue).OpenWysiwyg
if ($existingRun -and -not $existingRun.Contains($watcherPath)) { throw 'An OpenWysiwyg startup entry already belongs to another checkout.' }
if ($existingRun) {
    $startupBackup = Join-Path $stateRoot 'backups'
    New-Item -ItemType Directory -Path $startupBackup -Force | Out-Null
    @{ key = $runKey; name = 'OpenWysiwyg'; value = $existingRun } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $startupBackup ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-startup.json')) -Encoding UTF8
}
if ($Uninstall) {
    Stop-LocalEditor
    if ($existingRun) { Remove-ItemProperty -Path $runKey -Name OpenWysiwyg }
    Write-Output 'OpenWysiwyg local startup removed. Checkout, releases and browser drafts were kept.'
    return
}

if (-not $SkipBuild) {
    Push-Location $checkout
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
}
$dist = Join-Path $checkout 'dist'
if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html'))) { throw 'Build the application before publishing it.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$release = Join-Path $releaseRoot (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
New-Item -ItemType Directory -Path $release -Force | Out-Null
Get-ChildItem -LiteralPath $dist -Force | Copy-Item -Destination $release -Recurse -Force

Stop-LocalEditor
$listener = @(Get-NetTCPConnection -State Listen -LocalPort 4321 -ErrorAction SilentlyContinue)
if ($listener.Count) { throw "Port 4321 belongs to another process (PID $($listener[0].OwningProcess)). It was left running." }

$stateFile = Join-Path $stateRoot 'deployment.json'
if (Test-Path -LiteralPath $stateFile) {
    $backupRoot = Join-Path $stateRoot 'backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Copy-Item -LiteralPath $stateFile -Destination (Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json'))
}
$pendingState = Join-Path $stateRoot 'deployment.next.json'
@{ checkout = $checkout; node = $nodePath; staticRoot = $release; deployedAt = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $pendingState -Encoding UTF8
Move-Item -LiteralPath $pendingState -Destination $stateFile -Force

$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $watcherPath + '"'
if (-not (Test-Path -Path $runKey)) { New-Item -Path $runKey | Out-Null }
New-ItemProperty -Path $runKey -Name OpenWysiwyg -PropertyType String -Value ('"' + $powershell + '" ' + $arguments) -Force | Out-Null
Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $checkout -WindowStyle Hidden | Out-Null

$ready = $false
foreach ($attempt in 1..40) {
    try {
        $response = Invoke-WebRequest 'http://127.0.0.1:4321/' -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200 -and $response.Content.Contains('<title>OpenWysiwyg</title>')) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
}
if (-not $ready) { throw "The local editor did not start. See $stateRoot\logs." }
Write-Output 'OpenWysiwyg: http://127.0.0.1:4321/'
Write-Output "Published: $release"
Write-Output 'Starts hidden at Windows login and restarts its server after a failure.'

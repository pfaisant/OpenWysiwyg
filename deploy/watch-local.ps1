[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stateRoot = Join-Path $env:LOCALAPPDATA 'OpenWysiwyg'
$releaseRoot = Join-Path $stateRoot 'releases'
$logRoot = Join-Path $stateRoot 'logs'
$serverPath = Join-Path $checkout 'scripts\serve.mjs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$mutex = [Threading.Mutex]::new($false, 'Local\OpenWysiwyg.Local4321')
$ownsMutex = $false

try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { return }
    while ($true) {
        try {
            $deployment = Get-Content -LiteralPath (Join-Path $stateRoot 'deployment.json') -Raw | ConvertFrom-Json
            $published = [IO.Path]::GetFullPath($deployment.staticRoot)
            $allowed = [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\') + '\'
            if (-not $published.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Published directory is outside the local releases folder.' }
            if (-not (Test-Path -LiteralPath (Join-Path $published 'index.html'))) { throw 'The published release has no index.html.' }
            if (-not (Test-Path -LiteralPath $deployment.node)) { throw 'The configured Node executable is missing.' }
            $env:HOST = '127.0.0.1'
            $env:HOSTS = '127.0.0.1'
            $env:PORT = '4321'
            $env:STATIC_ROOT = $published
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
            $child = Start-Process -FilePath $deployment.node -ArgumentList ('"' + $serverPath + '"') `
                -WorkingDirectory $checkout -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $logRoot "$stamp.stdout.log") `
                -RedirectStandardError (Join-Path $logRoot "$stamp.stderr.log")
            @{ supervisorPid = $PID; serverPid = $child.Id; hosts = $env:HOSTS; startedAt = (Get-Date).ToUniversalTime().ToString('o'); staticRoot = $published } |
                ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateRoot 'runtime.json') -Encoding UTF8
            while (-not $child.HasExited) {
                Start-Sleep -Seconds 5
                $child.Refresh()
            }
        } catch {
            Add-Content -LiteralPath (Join-Path $logRoot 'supervisor.log') -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $_.Exception.Message)
        }
        Start-Sleep -Seconds 5
    }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

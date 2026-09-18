$ErrorActionPreference = 'Stop'

$appUrl = 'http://127.0.0.1:43127'
$healthUrl = "$appUrl/api/health"

function Test-VistaHealth {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

if (-not (Test-VistaHealth)) {
    $serverPath = Join-Path $PSScriptRoot 'server.cjs'
    if (-not (Test-Path -LiteralPath $serverPath)) {
        throw "Server file not found: $serverPath"
    }

    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process `
        -FilePath $nodePath `
        -ArgumentList @($serverPath) `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden

    $serverReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-VistaHealth) {
            $serverReady = $true
            break
        }
    }

    if (-not $serverReady) {
        throw 'Vista Studio local service did not become ready within 10 seconds.'
    }
}

$edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
)
$edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if ($edgePath) {
    Start-Process -FilePath $edgePath -ArgumentList @("--app=$appUrl", '--start-maximized')
}
else {
    Start-Process $appUrl
}

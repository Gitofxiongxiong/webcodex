[CmdletBinding()]
param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173,
    [switch]$Restart,
    [switch]$SkipInstall,
    [switch]$Open
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSCommandPath
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
$WorkerPyDir = Join-Path $Root "worker-py"
$DataDir = Join-Path $Root "data"
$EnvFile = Join-Path $Root ".env"
$EnvExample = Join-Path $Root ".env.example"
$VenvDir = Join-Path $BackendDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

function Write-Step {
    param([string]$Message)
    Write-Host "[webcodex] $Message" -ForegroundColor Cyan
}

function Find-CommandPath {
    param([string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        throw "Required command not found in PATH: $Name"
    }
    return $command.Source
}

function Get-PortProcessIds {
    param([int]$Port)
    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Stop-PortListeners {
    param(
        [string]$Name,
        [int]$Port
    )
    $processIds = @(Get-PortProcessIds -Port $Port)
    if ($processIds.Count -eq 0) {
        return
    }
    foreach ($processId in $processIds) {
        Write-Step "Stopping $Name listener on port $Port (pid $processId)"
        Stop-Process -Id $processId -Force
    }
}

function Test-PortListening {
    param([int]$Port)
    return @(Get-PortProcessIds -Port $Port).Count -gt 0
}

function Get-DependencyStamp {
    param([string[]]$Paths)
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($path in $Paths) {
        if (Test-Path $path) {
            $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
            $lines.Add("$path=$hash")
        }
    }
    return ($lines -join "`n")
}

function Ensure-EnvFile {
    if (Test-Path $EnvFile) {
        return
    }
    if (-not (Test-Path $EnvExample)) {
        throw ".env is missing and .env.example was not found"
    }
    Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
    Write-Step "Created .env from .env.example"
}

function Ensure-PythonEnvironment {
    $python = Find-CommandPath "python"
    if (-not (Test-Path $VenvPython)) {
        Write-Step "Creating backend virtual environment"
        & $python -m venv $VenvDir
    }

    if ($SkipInstall) {
        return
    }

    $requirements = Join-Path $BackendDir "requirements.txt"
    $workerPyProject = Join-Path $WorkerPyDir "pyproject.toml"
    $marker = Join-Path $VenvDir ".requirements.sha256"
    $stamp = Get-DependencyStamp @($requirements, $workerPyProject)
    $current = if (Test-Path $marker) { Get-Content -Raw -LiteralPath $marker } else { "" }
    if ($current -ne $stamp) {
        Write-Step "Installing backend and worker Python dependencies"
        & $VenvPython -m pip install -r $requirements
        & $VenvPython -m pip install -e $WorkerPyDir
        Set-Content -LiteralPath $marker -Value $stamp -NoNewline -Encoding UTF8
    }
}

function Ensure-NodePackage {
    param(
        [string]$Name,
        [string]$Directory
    )

    $npm = Find-CommandPath "npm"
    if ($SkipInstall) {
        return
    }

    $packageJson = Join-Path $Directory "package.json"
    $packageLock = Join-Path $Directory "package-lock.json"
    $nodeModules = Join-Path $Directory "node_modules"
    $marker = Join-Path $Directory ".npm.sha256"
    $stamp = Get-DependencyStamp @($packageJson, $packageLock)
    $current = if (Test-Path $marker) { Get-Content -Raw -LiteralPath $marker } else { "" }

    if ((-not (Test-Path $nodeModules)) -or $current -ne $stamp) {
        Write-Step "Installing $Name npm dependencies"
        Push-Location $Directory
        try {
            & $npm install
        } finally {
            Pop-Location
        }
        $stamp = Get-DependencyStamp @($packageJson, $packageLock)
        Set-Content -LiteralPath $marker -Value $stamp -NoNewline -Encoding UTF8
    }
}

function Ensure-NodeEnvironment {
    Find-CommandPath "node" | Out-Null
    Ensure-NodePackage -Name "frontend" -Directory $FrontendDir
}

function Start-Backend {
    if (Test-PortListening -Port $BackendPort) {
        Write-Step "Backend already listening at http://127.0.0.1:$BackendPort"
        return
    }

    $stdout = Join-Path $DataDir "backend.start.out.log"
    $stderr = Join-Path $DataDir "backend.start.err.log"
    Write-Step "Starting backend on port $BackendPort"
    Start-Process `
        -FilePath $VenvPython `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$BackendPort") `
        -WorkingDirectory $BackendDir `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden `
        -PassThru | Out-Null
}

function Start-Frontend {
    if (Test-PortListening -Port $FrontendPort) {
        Write-Step "Frontend already listening at http://127.0.0.1:$FrontendPort"
        return
    }

    $stdout = Join-Path $DataDir "frontend.start.out.log"
    $stderr = Join-Path $DataDir "frontend.start.err.log"
    Write-Step "Starting frontend on port $FrontendPort"
    $npm = Find-CommandPath "npm"
    Start-Process `
        -FilePath $npm `
        -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1", "--port", "$FrontendPort") `
        -WorkingDirectory $FrontendDir `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden `
        -PassThru | Out-Null
}

function Wait-Http {
    param(
        [string]$Name,
        [string]$Url
    )
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                Write-Step "$Name ready: $Url"
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    Write-Warning "$Name did not respond in time: $Url"
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Ensure-EnvFile
Ensure-PythonEnvironment
Ensure-NodeEnvironment

if ($Restart) {
    Stop-PortListeners -Name "backend" -Port $BackendPort
    Stop-PortListeners -Name "frontend" -Port $FrontendPort
    Start-Sleep -Seconds 1
}

Start-Backend
Start-Frontend

Wait-Http -Name "Backend" -Url "http://127.0.0.1:$BackendPort/health"
Wait-Http -Name "Frontend" -Url "http://127.0.0.1:$FrontendPort/"

Write-Host ""
Write-Host "WebCodex is running:" -ForegroundColor Green
Write-Host "  Frontend: http://127.0.0.1:$FrontendPort"
Write-Host "  Backend:  http://127.0.0.1:$BackendPort/docs"
Write-Host ""
Write-Host "Useful options:"
Write-Host "  .\start.ps1 -Restart      stop listeners on the ports before starting"
Write-Host "  .\start.ps1 -SkipInstall  skip dependency checks"
Write-Host "  .\start.ps1 -Open         open the frontend in your browser"

if ($Open) {
    Start-Process "http://127.0.0.1:$FrontendPort"
}

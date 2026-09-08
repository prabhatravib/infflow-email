# deploy-all.ps1 - Infflow Email Deployment Script
#requires -Version 5.1
param(
    [string]$Root = $PSScriptRoot,
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [switch]$SkipBuild,
    [switch]$Force,
    [string]$Environment = "production"
)

$ErrorActionPreference = 'Stop'
# Run unattended: never emit a confirmation prompt or a progress bar.
$ConfirmPreference = 'None'
$ProgressPreference = 'SilentlyContinue'
if (-not $Root) { $Root = (Get-Location).Path }

# Color functions for better output
function Write-Success { param($Message) Write-Host $Message -ForegroundColor Green }
function Write-Info { param($Message) Write-Host $Message -ForegroundColor Cyan }
function Write-Warning { param($Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Error { param($Message) Write-Host $Message -ForegroundColor Red }

# Configuration
$Config = @{
    FrontendApp = "infflow-email"
    BackendApp = "infflow-api-production"
    FrontendUrl = "https://infflow-email.prabhatravib.workers.dev"
    BackendUrl = "https://infflow-api-production.prabhatravib.workers.dev"
    # / just 302s to the frontend; /health is the actual liveness route (main.ts:629).
    BackendHealthUrl = "https://infflow-api-production.prabhatravib.workers.dev/health"
    FrontendDir = "apps\mail"
    BackendDir = "apps\server"
}


function Invoke-BuildProject {
    param(
        [string]$ProjectName,
        [string]$ProjectDir,
        [string]$BuildCommand = "build"
    )
    
    Write-Info "Building $ProjectName..."
    Push-Location $ProjectDir
    try {
        Write-Info "  Running: pnpm run $BuildCommand"
        & pnpm run $BuildCommand
        if ($LASTEXITCODE -ne 0) { 
            throw "$ProjectName build failed with exit code $LASTEXITCODE" 
        }
        Write-Success "[OK] $ProjectName built successfully"
    } catch {
        Write-Error "[ERROR] $ProjectName build failed: $_"
        throw
} finally {
    Pop-Location
}
}

function Invoke-DeployProject {
    param(
        [string]$ProjectName,
        [string]$ProjectDir,
        [string]$DeployCommand = "deploy",
        [string]$Environment = ""
    )
    
    Write-Info "Deploying $ProjectName..."
    Push-Location $ProjectDir
    try {
        if ($Environment -ne "") {
            Write-Info "  Running: pnpm run $DeployCommand --env=$Environment"
            & pnpm run $DeployCommand --env=$Environment
        } else {
            Write-Info "  Running: pnpm run $DeployCommand"
            & pnpm run $DeployCommand
        }
        if ($LASTEXITCODE -ne 0) { 
            throw "$ProjectName deployment failed with exit code $LASTEXITCODE" 
        }
        Write-Success "[OK] $ProjectName deployed successfully"
    } catch {
        Write-Error "[ERROR] $ProjectName deployment failed: $_"
        throw
    } finally {
        Pop-Location
    }
}

function Get-HttpStatus {
    param(
        [string]$Url,
        [int]$TimeoutSec = 30
    )

    # Deliberately NOT Invoke-WebRequest: in Windows PowerShell 5.1 it parses responses with
    # the Internet Explorer engine and interactively prompts ("Security Warning: Script
    # Execution Risk") on machines where IE first-run setup never completed. HttpWebRequest
    # never parses HTML, so it can never prompt.
    try {
        [System.Net.ServicePointManager]::SecurityProtocol =
            [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = 'GET'
        $request.AllowAutoRedirect = $false
        $request.Timeout = $TimeoutSec * 1000
        $request.UserAgent = 'infflow-deploy-healthcheck'

        $response = $request.GetResponse()
        $code = [int]$response.StatusCode
        $response.Close()
        return $code
    } catch [System.Net.WebException] {
        # A 4xx/5xx still means something answered - report its status rather than failing.
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            $_.Exception.Response.Close()
            return $code
        }
        return 0    # DNS failure, TLS error or timeout: nothing answered at all
    } catch {
        return 0
    }
}

function Test-Deployment {
    param(
        [string]$Url,
        [string]$ProjectName,
        [int]$Attempts = 3,
        [int]$RetryDelaySec = 5
    )

    Write-Info "Testing $ProjectName deployment at $Url..."

    for ($i = 1; $i -le $Attempts; $i++) {
        $status = Get-HttpStatus -Url $Url
        $label = if ($status -eq 0) { 'no response (DNS, TLS or timeout)' } else { "HTTP $status" }

        if ($status -eq 200) {
            Write-Success "[OK] $ProjectName is responding correctly (HTTP 200)"
            return $true
        }

        # A redirect or an auth challenge still proves the Worker is live and routing.
        if (($status -ge 300 -and $status -lt 400) -or $status -eq 401 -or $status -eq 403) {
            Write-Success "[OK] $ProjectName is live ($label)"
            return $true
        }

        if ($i -lt $Attempts) {
            Write-Info "  Attempt $i/$Attempts got $label - retrying in $RetryDelaySec s (a fresh deploy takes a moment to propagate)"
            Start-Sleep -Seconds $RetryDelaySec
        } else {
            Write-Warning "[WARNING] $ProjectName health check failed after $Attempts attempts: $label"
        }
    }

    return $false
}

function Show-DeploymentSummary {
    Write-Success "`n[SUCCESS] Deployment Summary"
    Write-Info "==================="
    Write-Info "Frontend: $($Config.FrontendUrl)"
    Write-Info "Backend:  $($Config.BackendUrl)"
    Write-Info "`nNext steps:"
    Write-Info "1. Test the application at: $($Config.FrontendUrl)"
    Write-Info "2. Check Cloudflare Workers dashboard for logs"
    Write-Info "3. Monitor application performance"
}

# Main execution
try {
    Write-Success "[START] Infflow Email Deployment Process"
    Write-Info "============================================="
    Write-Info "Environment: $Environment"
    Write-Info "Force mode: $Force"
    Write-Info "Skip backend: $SkipBackend"
    Write-Info "Skip frontend: $SkipFrontend"
    Write-Info "Skip build: $SkipBuild"
    Write-Info ""

    # Step 1: Install dependencies
    Write-Info "Installing dependencies..."
    Push-Location $Root
    try {
        & pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
        Write-Success "[OK] Dependencies installed successfully"
} finally {
    Pop-Location
}

    # Step 2: Build projects (if not skipped)
    if (-not $SkipBuild) {
        Write-Info "`nBuilding projects..."
        
        # Build frontend only (backend doesn't need build step)
        if (-not $SkipFrontend) {
            Invoke-BuildProject -ProjectName "Frontend" -ProjectDir $Config.FrontendDir
        }
        
        Write-Info "[INFO] Backend uses Cloudflare Workers - no build step needed"
    } else {
        Write-Warning "[WARNING] Skipping build step"
    }

    # Step 3: Deploy backend first
    if (-not $SkipBackend) {
        Write-Info "`nDeploying backend..."
        try {
            Invoke-DeployProject -ProjectName "Backend" -ProjectDir $Config.BackendDir -Environment "production"
            Write-Success "[OK] Backend deployment completed"
        } catch {
            Write-Error "[ERROR] Backend deployment failed. Stopping deployment process."
            Write-Error "Please fix the backend issues before proceeding."
            exit 1
        }
    } else {
        Write-Warning "[WARNING] Skipping backend deployment"
    }

    # Step 4: Deploy frontend
    if (-not $SkipFrontend) {
        Write-Info "`nDeploying frontend..."
        try {
            # NOTE: no -Environment here. The Cloudflare Vite plugin writes an already-resolved
            # config to build/client/wrangler.json, and wrangler rejects --env against a
            # redirected config. Select the env at build time with $env:CLOUDFLARE_ENV instead.
            Invoke-DeployProject -ProjectName "Frontend" -ProjectDir $Config.FrontendDir
            Write-Success "[OK] Frontend deployment completed"
        } catch {
            Write-Error "[ERROR] Frontend deployment failed."
            Write-Error "Backend is deployed but frontend failed. Check the errors above."
            exit 1
        }
    } else {
        Write-Warning "[WARNING] Skipping frontend deployment"
    }

    # Step 5: Health checks (optional)
    if (-not $SkipBackend -and -not $SkipFrontend) {
        Write-Info "`nPerforming health checks..."
        $backendHealthy = Test-Deployment -Url $Config.BackendHealthUrl -ProjectName "Backend"
        $frontendHealthy = Test-Deployment -Url $Config.FrontendUrl -ProjectName "Frontend"
        
        if ($backendHealthy -and $frontendHealthy) {
            Write-Success "[OK] All health checks passed"
        } else {
            Write-Warning "[WARNING] Some health checks failed, but deployment completed"
        }
    }

    # Step 6: Show summary
    Show-DeploymentSummary

} catch {
    Write-Error "`n[ERROR] Deployment failed: $_"
    Write-Error "Stack trace: $($_.ScriptStackTrace)"
    exit 1
}

Write-Success "`n[SUCCESS] Infflow-Email deployment process completed successfully!"

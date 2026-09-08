@echo off
setlocal EnableExtensions

chcp 65001 >nul

rem ---------------------------------------------------------------------------
rem deploy.bat - Infflow Email deployment (Cloudflare Workers)
rem
rem   Backend   apps\server -> infflow-api-production   (REQUIRES --env=production)
rem   Frontend  apps\mail   -> infflow-email            (must NOT pass --env)
rem
rem Runs unattended: nothing in here prompts for input.
rem Batch port of deploy-all.ps1, minus its duplicate frontend build.
rem ---------------------------------------------------------------------------

set "SCRIPT_DIR=%~dp0"
set "FORCE_INSTALL=0"
set "SKIP_BACKEND=0"
set "SKIP_FRONTEND=0"
set "SKIP_BUILD=0"
set "SKIP_HEALTH=0"
set "HEALTH_FAILED=0"

set "FRONTEND_URL=https://infflow-email.prabhatravib.workers.dev"
set "BACKEND_URL=https://infflow-api-production.prabhatravib.workers.dev"
rem / only 302s to the frontend; /health is the real liveness route (main.ts:629).
set "BACKEND_HEALTH_URL=https://infflow-api-production.prabhatravib.workers.dev/health"

:parse_args
if "%~1"=="" goto :args_done
set "ARG_OK=0"
if /I "%~1"=="--help" goto :help
if /I "%~1"=="-h" goto :help
if /I "%~1"=="--install" ( set "FORCE_INSTALL=1" & set "ARG_OK=1" )
if /I "%~1"=="--fresh" ( set "FORCE_INSTALL=1" & set "ARG_OK=1" )
if /I "%~1"=="--skip-build" ( set "SKIP_BUILD=1" & set "ARG_OK=1" )
if /I "%~1"=="--skip-backend" ( set "SKIP_BACKEND=1" & set "ARG_OK=1" )
if /I "%~1"=="--skip-frontend" ( set "SKIP_FRONTEND=1" & set "ARG_OK=1" )
if /I "%~1"=="--skip-health" ( set "SKIP_HEALTH=1" & set "ARG_OK=1" )
if "%ARG_OK%"=="0" (
    echo [deploy] Error: Unknown option "%~1". Run deploy.bat --help for usage.
    exit /b 1
)
shift
goto :parse_args
:args_done

rem Quiet, non-interactive tooling. CI=1 also keeps wrangler from prompting.
set "CI=1"
set "NPM_CONFIG_AUDIT=false"
set "NPM_CONFIG_FUND=false"
set "NPM_CONFIG_PROGRESS=false"
set "WRANGLER_SEND_METRICS=false"

rem A stray CLOUDFLARE_ENV would silently retarget the frontend at the
rem infflow-production worker: the Vite plugin reads it during the build.
set "CLOUDFLARE_ENV="

echo [deploy] Starting Infflow Email deployment...

pushd "%SCRIPT_DIR%" >nul
if errorlevel 1 (
    echo [deploy] Error: Failed to navigate to repository root.
    exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
    echo [deploy] Error: pnpm not found in PATH. Install it with: npm install -g pnpm
    popd
    exit /b 1
)

rem Always the workspace-pinned wrangler (4.22.x), never a global one: these
rem wrangler.jsonc files have only ever been verified against the pinned version.
set "WRANGLER=pnpm exec wrangler"

set "HAVE_CURL=1"
where curl >nul 2>&1
if errorlevel 1 set "HAVE_CURL=0"

rem ---------------------------------------------------------------- workspace
if not exist "node_modules" goto :do_install
if "%FORCE_INSTALL%"=="1" goto :do_install
echo [deploy] Reusing existing workspace dependencies. Use --install for a fresh install.
goto :after_install

:do_install
echo [deploy] Installing workspace dependencies...
rem --no-frozen-lockfile because CI=1 would otherwise make pnpm refuse to install
rem whenever package.json has moved ahead of pnpm-lock.yaml.
call pnpm install --no-frozen-lockfile
if errorlevel 1 (
    echo [deploy] Error: pnpm install failed.
    goto :error
)

:after_install

rem -------------------------------------------------------------------- build
if "%SKIP_FRONTEND%"=="1" goto :after_build
if "%SKIP_BUILD%"=="1" (
    echo [deploy] Skipping frontend build ^(--skip-build^).
    goto :after_build
)

echo [deploy] Building frontend...
pushd "apps\mail" >nul
if errorlevel 1 (
    echo [deploy] Error: Failed to navigate to apps\mail.
    goto :error
)
rem "oxlint Error: spawn pnpm ENOENT" is expected here and harmless on Windows:
rem vite-plugin-oxlint spawns bare "pnpm", which resolves only as pnpm.cmd.
call pnpm run build
if errorlevel 1 (
    echo [deploy] Error: Frontend build failed.
    popd
    goto :error
)
popd
echo [deploy] Frontend built. Backend is a Worker - no build step needed.

:after_build

rem ------------------------------------------------------------------ backend
if "%SKIP_BACKEND%"=="1" (
    echo [deploy] Skipping backend deployment ^(--skip-backend^).
    goto :after_backend
)

echo [deploy] Deploying backend to infflow-api-production...
pushd "apps\server" >nul
if errorlevel 1 (
    echo [deploy] Error: Failed to navigate to apps\server.
    goto :error
)
rem --env=production is REQUIRED: it selects the env block named
rem infflow-api-production, which also omits the queues this plan cannot use.
call %WRANGLER% deploy --env=production
if errorlevel 1 (
    echo [deploy] Error: Backend deployment failed. Stopping before the frontend.
    popd
    goto :error
)
popd

:after_backend

rem ----------------------------------------------------------------- frontend
if "%SKIP_FRONTEND%"=="1" (
    echo [deploy] Skipping frontend deployment ^(--skip-frontend^).
    goto :after_frontend
)

echo [deploy] Deploying frontend to infflow-email...
pushd "apps\mail" >nul
if errorlevel 1 (
    echo [deploy] Error: Failed to navigate to apps\mail.
    goto :error
)
if not exist "build\client\wrangler.json" (
    echo [deploy] Error: build\client\wrangler.json is missing - build the frontend first.
    popd
    goto :error
)
rem No --env here. The Cloudflare Vite plugin writes an already-resolved config to
rem build\client\wrangler.json, and wrangler rejects --env against a redirected
rem config: "You need to set the environment in your build tool".
call %WRANGLER% deploy
if errorlevel 1 (
    echo [deploy] Error: Frontend deployment failed. Backend is already deployed.
    popd
    goto :error
)
popd

:after_frontend

rem ------------------------------------------------------------ health checks
if "%SKIP_HEALTH%"=="1" goto :after_health
if "%HAVE_CURL%"=="0" (
    echo [deploy] Warning: curl not found in PATH - skipping health checks.
    goto :after_health
)

if "%SKIP_BACKEND%"=="1" goto :health_frontend
call :health_check "Backend" "%BACKEND_HEALTH_URL%"
if errorlevel 1 set "HEALTH_FAILED=1"

:health_frontend
if "%SKIP_FRONTEND%"=="1" goto :after_health
call :health_check "Frontend" "%FRONTEND_URL%"
if errorlevel 1 set "HEALTH_FAILED=1"

:after_health

rem ---------------------------------------------------------------- summary
echo.
echo [deploy] Deployment summary
echo [deploy]   Frontend: %FRONTEND_URL%
echo [deploy]   Backend:  %BACKEND_URL%
if "%HEALTH_FAILED%"=="1" (
    echo [deploy] Warning: a health check did not pass - see the warnings above.
)
echo [deploy] Deployment completed on %date% %time:~0,5%
popd

call :play_success_sound
exit /b 0

rem ----------------------------------------------------------------- routines
:health_check
rem %~1 = label, %~2 = url
set "HC_NAME=%~1"
set "HC_URL=%~2"
set "HC_ATTEMPT=0"
echo [deploy] Checking %HC_NAME% at %HC_URL% ...

:health_retry
set /a HC_ATTEMPT+=1
set "HTTP_CODE=000"
for /f "usebackq delims=" %%i in (`curl -s -o nul -w "%%{http_code}" --max-time 30 "%HC_URL%"`) do set "HTTP_CODE=%%i"
if "%HTTP_CODE%"=="200" (
    echo [deploy] OK: %HC_NAME% is responding correctly ^(HTTP 200^).
    exit /b 0
)
rem A redirect or an auth challenge still proves the Worker is live and routing.
if "%HTTP_CODE:~0,1%"=="3" goto :health_live
if "%HTTP_CODE%"=="401" goto :health_live
if "%HTTP_CODE%"=="403" goto :health_live
if %HC_ATTEMPT% GEQ 3 (
    echo [deploy] Warning: %HC_NAME% health check failed after 3 attempts ^(HTTP %HTTP_CODE%^).
    exit /b 1
)
echo [deploy] %HC_NAME% returned HTTP %HTTP_CODE% - retrying in 5s ^(a fresh deploy takes a moment to propagate^).
ping -n 6 127.0.0.1 >nul
goto :health_retry

:health_live
echo [deploy] OK: %HC_NAME% is live ^(HTTP %HTTP_CODE%^).
exit /b 0

:error
popd
exit /b 1

:play_success_sound
powershell -NoProfile -Command "try { [console]::beep(880,180); Start-Sleep -Milliseconds 80; [console]::beep(1175,260) } catch { try { [System.Media.SystemSounds]::Asterisk.Play() } catch {} }" >nul 2>&1
exit /b 0

:help
echo Usage: deploy.bat [--install^|--fresh] [--skip-build] [--skip-backend] [--skip-frontend] [--skip-health]
echo.
echo   Default          Reuse existing dependencies, build the frontend once, then
echo                    deploy backend + frontend and health-check both.
echo   --install        Run pnpm install before building.
echo   --fresh          Alias for --install.
echo   --skip-build     Deploy the existing apps\mail\build output as-is.
echo   --skip-backend   Deploy the frontend only.
echo   --skip-frontend  Deploy the backend only.
echo   --skip-health    Skip the post-deploy health checks.
exit /b 0

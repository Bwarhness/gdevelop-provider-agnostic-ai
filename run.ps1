# Launches the AI proxy (4000) and the GDevelop IDE dev server (3000).
# Usage:  pwsh ./run.ps1     (or right-click > Run with PowerShell)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Test-Port($port) {
  $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# 1) AI proxy
if (Test-Port 4000) {
  Write-Host "Proxy already running on :4000" -ForegroundColor Yellow
} else {
  if (-not (Test-Path "$root\ai-proxy\node_modules")) { Push-Location "$root\ai-proxy"; npm install; Pop-Location }
  if (-not (Test-Path "$root\ai-proxy\.env")) { Write-Host "WARNING: ai-proxy\.env missing — copy .env.example and set your provider." -ForegroundColor Red }
  Write-Host "Starting AI proxy on :4000 ..." -ForegroundColor Cyan
  Start-Process -FilePath "node" -ArgumentList "--env-file=.env","src/server.js" -WorkingDirectory "$root\ai-proxy" -WindowStyle Minimized
}

# 2) IDE dev server
if (Test-Port 3000) {
  Write-Host "IDE dev server already running on :3000" -ForegroundColor Yellow
} else {
  Write-Host "Starting GDevelop IDE dev server on :3000 (first compile takes ~1-2 min) ..." -ForegroundColor Cyan
  $env:BROWSER = 'none'
  Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory "$root\GDevelop\newIDE\app" -WindowStyle Minimized
}

Write-Host ""
Write-Host "Proxy:  http://localhost:4000   (health check)" -ForegroundColor Green
Write-Host "Editor: http://localhost:3000   -> click 'Ask AI'" -ForegroundColor Green
Write-Host "Mode is set in GDevelop\newIDE\app\.env.local (REACT_APP_LOCAL_AI_MODE=chat|agent)."

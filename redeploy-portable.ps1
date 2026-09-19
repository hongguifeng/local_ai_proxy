# Redeploy the newest portable build: kill running instances, copy the exe, relaunch.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File redeploy-portable.ps1
$ErrorActionPreference = 'Stop'

$releaseDir = 'D:\code\local_ai_proxy\release'
$targetDir = 'D:\Portable Program\llm_proxy'

# 1. Kill all running LLM Proxy processes (the app itself and the portable NSIS wrapper)
$procs = Get-Process -Name 'LLM Proxy*', 'LLM-Proxy*' -ErrorAction SilentlyContinue
if ($procs) {
  $procs | ForEach-Object { Write-Host ("Killing {0} (PID {1})" -f $_.Name, $_.Id) }
  $procs | Stop-Process -Force
} else {
  Write-Host 'No running LLM Proxy processes.'
}

# Wait until the processes are gone so the exe file is no longer locked.
for ($i = 0; $i -lt 50; $i++) {
  if (-not (Get-Process -Name 'LLM Proxy*', 'LLM-Proxy*' -ErrorAction SilentlyContinue)) {
    break
  }
  Start-Sleep -Milliseconds 200
}
$left = Get-Process -Name 'LLM Proxy*', 'LLM-Proxy*' -ErrorAction SilentlyContinue
if ($left) {
  Write-Error 'Some LLM Proxy processes are still running; cannot replace the exe.'
}

# 2. Copy the newest portable exe from release\ into the install dir (same file name)
$latest = Get-ChildItem -Path $releaseDir -Filter '*-portable.exe' -ErrorAction Stop |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if (-not $latest) {
  throw "No *-portable.exe found in $releaseDir"
}
$dest = Join-Path $targetDir $latest.Name
Copy-Item -LiteralPath $latest.FullName -Destination $dest -Force
Write-Host ("Copied {0} -> {1}" -f $latest.Name, $targetDir)

# 3. Launch the freshly copied exe and verify it actually runs before exiting
# The admin host/port come from the install dir's llm-proxy.json (default 127.0.0.1:18080).
$adminHost = '127.0.0.1'
$adminPort = 18080
$configFile = Join-Path $targetDir 'llm-proxy.json'
if (Test-Path -LiteralPath $configFile) {
  try {
    $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($cfg.admin) {
      if ($cfg.admin.host) { $adminHost = $cfg.admin.host }
      if ($cfg.admin.port) { $adminPort = $cfg.admin.port }
    }
  } catch {
    Write-Warning "Could not parse $configFile; falling back to ${adminHost}:${adminPort}"
  }
}

Start-Process -FilePath $dest
Write-Host ("Started {0}; waiting until it is running..." -f $dest)

$adminUrl = "http://${adminHost}:${adminPort}/"
# The app must be up within 10 seconds, otherwise the launch is treated as failed.
$deadline = (Get-Date).AddSeconds(10)
$lastProblem = 'no process yet'
while ((Get-Date) -lt $deadline) {
  $appProc = Get-Process -Name 'LLM Proxy' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($appProc) {
    try {
      $resp = Invoke-WebRequest -Uri $adminUrl -UseBasicParsing -TimeoutSec 2
      $lastProblem = "HTTP status $($resp.StatusCode)"
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
        Write-Host ("LLM Proxy is running (PID {0}, admin at {1})." -f $appProc.Id, $adminUrl)
        exit 0
      }
    } catch {
      $lastProblem = "HTTP error: $($_.Exception.Message)"
    }
  } else {
    $lastProblem = 'no "LLM Proxy" process'
  }
  Start-Sleep -Milliseconds 500
}

$processDump = (Get-Process -Name 'LLM Proxy*', 'LLM-Proxy*' -ErrorAction SilentlyContinue |
  ForEach-Object { '  ' + $_.Name + ' (PID ' + $_.Id + ') ' + $_.Path }) -join "`n"
if ($processDump) { $processDump = 'Remaining processes:' + "`n" + $processDump } else { $processDump = 'No LLM Proxy processes left.' }
$failMessage = "LLM Proxy did not start within 10s (checked process 'LLM Proxy' and $adminUrl).`nLast problem: $lastProblem`n$processDump"
Write-Error $failMessage

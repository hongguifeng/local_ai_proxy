param([int]$Port = 8088)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'runtime\node.exe'
$cli = Join-Path $root 'app\node_modules\@llm-proxy\server\dist\cli.js'
$config = Join-Path $root 'data\config.json'
$logs = Join-Path $root 'data\logs'
$arguments = @($cli, '--config-file', $config, '--log-root', $logs, '--port', $Port, '--no-browser')
$server = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = 'LLM Proxy'
$icon.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open Admin UI')
$exit = $menu.Items.Add('Exit')
$open.Add_Click({ Start-Process "http://127.0.0.1:$Port/" })
$exit.Add_Click({ if (-not $server.HasExited) { $server.Kill() }; $icon.Visible = $false; [System.Windows.Forms.Application]::ExitThread() })
$icon.ContextMenuStrip = $menu
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if ($server.HasExited) { throw 'LLM Proxy exited during startup' }
    try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "http://127.0.0.1:$Port/api/v1/health"; if ($response.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 50 }
  }
  if (-not $ready) { throw 'LLM Proxy health check timed out' }
  $icon.ShowBalloonTip(2000, 'LLM Proxy', 'Server is ready', [System.Windows.Forms.ToolTipIcon]::Info)
  [System.Windows.Forms.Application]::Run()
} catch {
  $icon.ShowBalloonTip(5000, 'LLM Proxy failed', $_.Exception.Message, [System.Windows.Forms.ToolTipIcon]::Error)
  Start-Sleep -Seconds 5
} finally {
  if (-not $server.HasExited) { $server.Kill() }
  $icon.Dispose()
}

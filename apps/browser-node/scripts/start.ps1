$ErrorActionPreference = "Stop"
$browserNodeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$envFile = Join-Path $browserNodeRoot ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\s*([^#][^=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process") }
  }
}
Set-Location $repositoryRoot
pnpm build
pnpm --filter @crawl-automation/browser-node start

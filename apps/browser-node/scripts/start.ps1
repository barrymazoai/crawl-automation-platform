$ErrorActionPreference = "Stop"
if (Test-Path ".env") {
  Get-Content ".env" | ForEach-Object {
    if ($_ -match "^\s*([^#][^=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process") }
  }
}
corepack pnpm build
corepack pnpm --filter @crawl-automation/browser-node start

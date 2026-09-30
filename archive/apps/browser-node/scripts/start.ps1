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
# 启动前打印当前代码版本：这个脚本不会自动 git pull，更新代码要先手动 pull
Write-Host ("browser-node code: " + (git rev-parse --short HEAD) + "  (" + (git log -1 --format=%cd --date=short) + ")  branch=" + (git rev-parse --abbrev-ref HEAD))
git status --short --branch | Select-Object -First 1
pnpm build
pnpm --filter @crawl-automation/browser-node start

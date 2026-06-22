param(
  [Parameter(Mandatory=$true)][string]$Branch
)

Write-Host "=== CI Health Check: $Branch ==="

$projectRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $projectRoot) {
  Write-Error "Not in a git repository"
  exit 1
}

$originalBranch = (git branch --show-current 2>$null)
$tauriDir = Join-Path $projectRoot "apps\tauri\src-tauri"

Write-Host "[1/4] Fetching $Branch..."
git fetch origin $Branch 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to fetch branch: $Branch"
  exit 1
}

Write-Host "[2/4] Checking out $Branch..."
git checkout $Branch 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to checkout branch: $Branch"
  exit 1
}

Write-Host "[3/4] Running cargo check..."
$cargoResult = cargo check --manifest-path "$tauriDir\Cargo.toml" 2>&1
$cargoCode = $LASTEXITCODE
if ($cargoCode -ne 0) {
  Write-Error "HEALTH: BROKEN — cargo check failed on $Branch"
  Write-Error $cargoResult
  Write-Output "BROKEN:cargo_check"
  if ($originalBranch) { git checkout $originalBranch 2>&1 | Out-Null }
  exit 1
}
Write-Host "  PASS"

Write-Host "[4/4] Running pnpm build..."
$pnpmResult = pnpm --filter @fredo/ui build 2>&1
$pnpmCode = $LASTEXITCODE
if ($pnpmCode -ne 0) {
  Write-Error "HEALTH: BROKEN — pnpm build failed on $Branch"
  Write-Error $pnpmResult
  Write-Output "BROKEN:pnpm_build"
  if ($originalBranch) { git checkout $originalBranch 2>&1 | Out-Null }
  exit 1
}
Write-Host "  PASS"

if ($originalBranch) {
  git checkout $originalBranch 2>&1 | Out-Null
}

Write-Host "`n=== CI Health: HEALTHY ==="
Write-Output "HEALTHY"

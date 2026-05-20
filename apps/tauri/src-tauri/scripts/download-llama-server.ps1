Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoApi = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
$headers = @{ "User-Agent" = "Fredo-App" }

Write-Host "Fetching latest llama.cpp release info..."
$release = Invoke-RestMethod -Uri $repoApi -Headers $headers
Write-Host "Latest release: $($release.tag_name)"

# Prefer CPU-only build — works everywhere without extra runtime DLLs.
# Vulkan build requires vulkan-1.dll (0xc0000135 crash when missing).
# Priority: cpu > openblas > avx2 > avx > vulkan > any Windows x64 zip
$asset = $null
$patterns = @("*win-cpu-x64*", "*win-openblas-x64*", "*win-avx2-x64*", "*win-avx-x64*", "*win-vulkan-x64*", "*win*x64*")
foreach ($pat in $patterns) {
    $asset = $release.assets | Where-Object { $_.name -like $pat -and $_.name -like "*.zip" } | Select-Object -First 1
    if ($asset) {
        Write-Host "Selected build: $($asset.name)"
        break
    }
}
if (-not $asset) {
    Write-Error "Could not find a Windows x64 asset in the latest release. Available assets:`n$($release.assets.name -join "`n")"
    exit 1
}

$sizeMB = [math]::Round($asset.size / 1MB, 1)
Write-Host "Downloading $($asset.name) ($sizeMB MB)..."

$tmpZip = Join-Path $env:TEMP "llama-cpp-win.zip"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpZip -Headers $headers

$tmpDir = Join-Path $env:TEMP "llama-cpp-extract"
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }

Write-Host "Extracting archive..."
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force

$serverExe = Get-ChildItem $tmpDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
if (-not $serverExe) {
    Write-Error "llama-server.exe not found in archive. Contents:`n$(Get-ChildItem $tmpDir -Recurse | Select-Object -ExpandProperty Name)"
    exit 1
}

$binDir = Join-Path $PSScriptRoot ".." "binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Copy llama-server.exe with the Tauri triple-arch suffix
$dest = Join-Path $binDir "llama-server-x86_64-pc-windows-msvc.exe"
Copy-Item $serverExe.FullName $dest -Force
Write-Host "Installed llama-server to: $dest"

# Copy all DLLs from the same directory as llama-server.exe so it can find
# ggml.dll, llama.dll, libomp140.x86_64.dll, mtmd.dll, ggml-cpu-*.dll etc.
$serverDir = Split-Path $serverExe.FullName
Get-ChildItem $serverDir -Filter "*.dll" | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $binDir $_.Name) -Force
    Write-Host "  + $($_.Name)"
}

# Cleanup
Remove-Item $tmpZip -Force
Remove-Item $tmpDir -Recurse -Force

Write-Host "Done."

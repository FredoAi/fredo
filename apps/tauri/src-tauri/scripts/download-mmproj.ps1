Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$modelDir = Join-Path $PSScriptRoot ".." "models" "gemma-e2b-it"
$modelDir = [System.IO.Path]::GetFullPath($modelDir)
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

# ── Gemma 4 E2B Q4_K_M main model ─────────────────────────────────────────────
$modelUrl  = "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf"
$modelDest = Join-Path $modelDir "gemma-4-E2B-it-Q4_K_M.gguf"

if (Test-Path $modelDest) {
    $sizeMB = [math]::Round((Get-Item $modelDest).Length / 1MB, 1)
    Write-Host "Gemma model already exists ($sizeMB MB): $modelDest"
} else {
    Write-Host "Downloading gemma-4-E2B-it-Q4_K_M.gguf (~3.1 GB) ..."
    Write-Host "  from: $modelUrl"
    Write-Host "  to:   $modelDest"
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "Fredo-App")
    try { $wc.DownloadFile($modelUrl, $modelDest) } finally { $wc.Dispose() }
    $sizeMB = [math]::Round((Get-Item $modelDest).Length / 1MB, 1)
    Write-Host "Downloaded Gemma model ($sizeMB MB)"
}

# ── mmproj-F16 vision projector ────────────────────────────────────────────────
$mprojUrl  = "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-F16.gguf"
$mprojDest = Join-Path $modelDir "mmproj-F16.gguf"

if (Test-Path $mprojDest) {
    $sizeMB = [math]::Round((Get-Item $mprojDest).Length / 1MB, 1)
    Write-Host "mmproj-F16.gguf already exists ($sizeMB MB): $mprojDest"
} else {
    Write-Host "Downloading mmproj-F16.gguf (~986 MB) ..."
    Write-Host "  from: $mprojUrl"
    Write-Host "  to:   $mprojDest"
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "Fredo-App")
    try { $wc.DownloadFile($mprojUrl, $mprojDest) } finally { $wc.Dispose() }
    $sizeMB = [math]::Round((Get-Item $mprojDest).Length / 1MB, 1)
    Write-Host "Downloaded mmproj-F16.gguf ($sizeMB MB)"
}

Write-Host "Done."


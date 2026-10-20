$ErrorActionPreference = 'Stop'
$oldPath = $env:PATH
$node = Join-Path $PSScriptRoot '.node22'
Push-Location -LiteralPath $PSScriptRoot
try {
  if (Test-Path -LiteralPath $node) {
    if (($env:PATH -split ';') -notcontains $node) { $env:PATH = "$node;$env:PATH" }
  } else {
    Write-Warning "No portable Node at $node; using the Node on PATH (need >= 20)."
  }
  pnpm dev
  $code = $LASTEXITCODE
} finally {
  Pop-Location
  $env:PATH = $oldPath
}
exit $code

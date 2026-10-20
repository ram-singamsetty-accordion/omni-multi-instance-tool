$env:PATH = (Resolve-Path "$PSScriptRoot\.node22").Path + ";" + $env:PATH
pnpm dev

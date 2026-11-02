# Dev helper: copy the extension into AE's CEP extensions folder (symlink needs admin, so copy).
# Windows only. On macOS copy extension/ to
#   ~/Library/Application Support/Adobe/CEP/extensions/studio.bridge.cavalry
$src = Join-Path (Split-Path $PSScriptRoot -Parent) "extension"
$dst = "$env:APPDATA\Adobe\CEP\extensions\studio.bridge.cavalry"
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue }
Copy-Item $src $dst -Recurse -Force
Write-Output "redeployed to $dst"

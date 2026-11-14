# Runs the native backend tests on Windows.
#
# The backend links comctl32 v6 (TaskDialogIndirect, used by the dialog plugin).
# Tauri embeds the common-controls manifest only in the app binary, so a test
# binary starts against comctl32 v5 and dies before running a single test with
# 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND. A manifest file next to the test
# binary gives it the same dependency without touching how the app is linked.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$manifest = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>
</assembly>
'@

$cargo = @('+stable', 'test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib')
$messages = & cargo @cargo --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$binaries = @($messages | ForEach-Object {
    try { $_ | ConvertFrom-Json } catch { $null }
  } | Where-Object { $_ -and $_.reason -eq 'compiler-artifact' -and $_.executable -and $_.profile.test } | ForEach-Object { $_.executable })
if ($binaries.Count -eq 0) { throw 'cargo did not report a test binary' }
foreach ($binary in $binaries) {
  Set-Content -LiteralPath "$binary.manifest" -Value $manifest -Encoding utf8
}

& cargo @cargo
exit $LASTEXITCODE

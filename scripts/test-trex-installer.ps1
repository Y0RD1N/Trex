#requires -Version 7.0
param(
    [string]$GeneratedInstaller = (Join-Path $PSScriptRoot '..\src-tauri\target\release\nsis\x64\installer.nsi'),
    [string]$MakeNsis = (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe')
)

# Compile and execute the actual rendered Tauri installer after replacing every
# product identity and registry root. Never execute the production installer.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$generated = (Resolve-Path -LiteralPath $GeneratedInstaller).Path
$compiler = (Resolve-Path -LiteralPath $MakeNsis).Path
$identity = 'trex-cli-test-' + [Guid]::NewGuid().ToString('N')
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = [IO.Path]::GetFullPath((Join-Path $tempBase $identity))
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid temporary root.' }
$registryRoot = "Software\TrexInstallerTests\$identity"
$productRoot = "Software\$identity"
$uninstallRoot = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$identity"
$registryView = [Microsoft.Win32.RegistryView]::Registry64
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $registryView)
New-Item -ItemType Directory -Path $testRoot | Out-Null
# Provision only this synthetic tree as private before creating storage fixtures.
# The CLI deliberately rejects an existing shared TREX_HOME without repairing it.
$testOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$testDirectory = [IO.DirectoryInfo]::new($testRoot)
$testAcl = [Security.AccessControl.DirectorySecurity]::new()
$testAcl.SetAccessRuleProtection($true, $false)
$testAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $testOwner,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
))
# Only persist the DACL: the newly created directory already has the right owner.
# Set-Acl can try to write owner/SACL fields and require SeSecurityPrivilege.
[IO.FileSystemAclExtensions]::SetAccessControl($testDirectory, $testAcl)
$actualTestAcl = [IO.FileSystemAclExtensions]::GetAccessControl(
    $testDirectory, [Security.AccessControl.AccessControlSections]'Owner, Access'
)
$testRules = @($actualTestAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($actualTestAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $testOwner.Value) {
    throw 'Synthetic test root is not owned by the current user.'
}
if (-not $actualTestAcl.AreAccessRulesProtected -or $testRules.Count -ne 1 -or
    $testRules[0].IdentityReference.Value -ne $testOwner.Value -or
    $testRules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
    $testRules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
    $testRules[0].InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -or
    $testRules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
    $testRules[0].IsInherited) {
    throw 'Synthetic test root does not have the expected current-user-only DACL.'
}
$roaming = Join-Path $testRoot 'roaming-appdata'
$localData = Join-Path $testRoot 'local-appdata'
$config = Join-Path $roaming 'trex-agent'
$cleanupAllowed = $true

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Replace-Define([string]$Source, [string]$Name, [string]$Value) {
    $pattern = '(?m)^!define ' + [regex]::Escape($Name) + ' "[^\r\n]*"\r?$'
    Assert-True ([regex]::Matches($Source, $pattern).Count -eq 1) "Expected one $Name definition."
    return [regex]::Replace($Source, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) "!define $Name `"$Value`"" })
}

function Invoke-Isolated([string]$Executable, [string]$Arguments, [int]$ExpectedExit = 0, [scriptblock]$ProcessFactory = { param($info) [Diagnostics.Process]::Start($info) }) {
    $resolvedExecutable = [IO.Path]::GetFullPath($Executable)
    Assert-True ($resolvedExecutable.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) 'Refusing to run an executable outside the isolated temporary tree.'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $resolvedExecutable
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $testRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.Environment['APPDATA'] = $roaming
    $start.Environment['LOCALAPPDATA'] = $localData
    $start.Environment['TREX_HOME'] = $config
    # From this point on, any launch/wait/kill exception must retain the test
    # tree and keys until termination can actually be confirmed.
    $script:cleanupAllowed = $false
    $process = $null
    try {
        $process = & $ProcessFactory $start
        if (-not $process.WaitForExit(60000)) {
            $process.Kill($true)
            if (-not $process.WaitForExit(10000)) {
                throw 'Isolated installer did not terminate; preserving its isolated test tree for inspection.'
            }
            $script:cleanupAllowed = $true
            throw 'Isolated installer timed out.'
        }
        $script:cleanupAllowed = $true
        Assert-True ($process.ExitCode -eq $ExpectedExit) "Installer exited $($process.ExitCode), expected $ExpectedExit."
    } finally { if ($null -ne $process) { $process.Dispose() } }
}

function Get-Choice {
    $key = $registry.OpenSubKey($registryRoot)
    if ($null -eq $key) { return $null }
    try { return $key.GetValue('InstallCli') } finally { $key.Dispose() }
}

try {
    $source = [IO.File]::ReadAllText($generated)
    Assert-True ($source.Contains('Page custom TrexCliPageCreate TrexCliPageLeave')) 'Generated installer has no CLI checkbox page.'
    Assert-True ($source.Contains('Call TrexCliInitialize')) 'Generated installer has no CLI initialization.'
    $payloadSource = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src-tauri\installer\payload\trex-agent.exe')).Path
    $payloadHash = (Get-FileHash -LiteralPath $payloadSource).Hash
    $binaryMatch = [regex]::Match($source, '(?m)^!define MAINBINARYSRCPATH "([^"\r\n]+)"')
    Assert-True $binaryMatch.Success 'Generated main binary path is missing.'
    $mainBinary = Join-Path $testRoot "$identity.exe"
    Copy-Item -LiteralPath $binaryMatch.Groups[1].Value -Destination $mainBinary
    foreach ($name in @('PRODUCTNAME', 'MANUFACTURER', 'BUNDLEID', 'MAINBINARYNAME')) {
        $source = Replace-Define $source $name $identity
    }
    $source = Replace-Define $source 'MAINBINARYSRCPATH' $mainBinary
    $installer = Join-Path $testRoot 'isolated-setup.exe'
    $source = Replace-Define $source 'OUTFILE' $installer
    $source = Replace-Define $source 'UNINSTALLERSIGNCOMMAND' ''
    $source = Replace-Define $source 'MINIMUMWEBVIEW2VERSION' ''
    # NSIS resolves known folders independently of process environment. Replace
    # its folder tokens in the test source and hook copy as well as setting the
    # child environment, so sentinels occupy the actual paths under test.
    $source = $source.Replace('$APPDATA', $roaming).Replace('$LOCALAPPDATA', $localData)
    $hookSourcePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src-tauri\installer\trex-cli.nsh')).Path
    $hookMatches = [regex]::Matches($source, '(?m)^!include "([^"\r\n]*trex-cli\.nsh)"\r?$')
    Assert-True ($hookMatches.Count -eq 1) 'Expected the current CLI hook include exactly once.'
    $renderedHookPath = [IO.Path]::GetFullPath($hookMatches[0].Groups[1].Value, (Split-Path -Parent $generated))
    Assert-True ($renderedHookPath.Equals($hookSourcePath, [StringComparison]::OrdinalIgnoreCase)) 'Unexpected CLI hook source.'
    $hookInclude = $hookMatches[0].Value
    $hookCopy = Join-Path $testRoot 'isolated-trex-cli.nsh'
    $hookSource = [IO.File]::ReadAllText($hookSourcePath).Replace('$APPDATA', $roaming).Replace('$LOCALAPPDATA', $localData)
    [IO.File]::WriteAllText($hookCopy, $hookSource, [Text.UTF8Encoding]::new($false))
    $source = $source.Replace($hookInclude, ('!include "' + $hookCopy + '"'))
    # Tests exercise the actual install/uninstall sections and CLI hooks but
    # cannot launch a runtime installer, updater, or the application itself.
    $webviewPattern = '(?ms)^Section WebView2\r?\n.*?^SectionEnd\r?\n'
    Assert-True ([regex]::Matches($source, $webviewPattern).Count -eq 1) 'Expected one WebView section.'
    $source = [regex]::Replace($source, $webviewPattern, "Section WebView2`r`nSectionEnd`r`n")
    foreach ($function in @('RunMainBinary', '.onInstSuccess')) {
        $pattern = '(?ms)^Function ' + [regex]::Escape($function) + '\r?\n.*?^FunctionEnd\r?\n'
        Assert-True ([regex]::Matches($source, $pattern).Count -eq 1) "Expected one $function callback."
        $source = [regex]::Replace($source, $pattern, "Function $function`r`nFunctionEnd`r`n")
    }
    $source = "!define TREX_CLI_REGISTRY_KEY `"$registryRoot`"`r`n" + $source
    $isolatedScript = Join-Path $testRoot 'isolated-installer.nsi'
    [IO.File]::WriteAllText($isolatedScript, $source, [Text.UTF8Encoding]::new($false))
    # Relative support includes resolve against Tauri's generated directory.
    Push-Location -LiteralPath (Split-Path -Parent $generated)
    try {
        & $compiler /NOCONFIG /WX /INPUTCHARSET UTF8 /OUTPUTCHARSET UTF8 /V2 /NOCD $isolatedScript
        Assert-True ($LASTEXITCODE -eq 0) 'Could not compile the isolated full Tauri NSIS installer.'
    } finally { Pop-Location }

    $off = Join-Path $testRoot 'fresh-off'
    Invoke-Isolated $installer "/S /NS /UPDATE /D=$off"
    Assert-True (Test-Path -LiteralPath (Join-Path $off "$identity.exe")) 'Application was not installed in the isolated directory.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $off 'trex-agent.exe'))) 'Fresh silent installation opted into CLI.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $off 'trex-agent.payload'))) 'Unselected payload was left installed.'
    Assert-True ((Get-Choice) -eq 0) 'Fresh default-off choice was not persisted.'
    Write-Output 'PASS fresh silent installation: CLI absent, inert payload removed, preference=0.'

    $selected = Join-Path $testRoot 'selected'
    New-Item -ItemType Directory -Path $config | Out-Null
    $profileSentinel = Join-Path $config 'profiles.json'
    $credentialDirectory = Join-Path $config 'credentials'
    New-Item -ItemType Directory -Path $credentialDirectory | Out-Null
    $credentialSentinel = Join-Path $credentialDirectory ([Guid]::NewGuid().ToString() + '.dpapi')
    [IO.File]::WriteAllText($profileSentinel, '{"sentinel":"preserve profiles"}')
    [IO.File]::WriteAllText($credentialSentinel, 'test credential sentinel (not a real API key)')
    $profileHash = (Get-FileHash -LiteralPath $profileSentinel).Hash
    $credentialHash = (Get-FileHash -LiteralPath $credentialSentinel).Hash
    $appConfigDirectory = Join-Path $roaming $identity
    New-Item -ItemType Directory -Path $appConfigDirectory | Out-Null
    $appConfigSentinel = Join-Path $appConfigDirectory 'config.json'
    [IO.File]::WriteAllText($appConfigSentinel, '{"version":1,"sentinel":"existing application settings"}')
    $appConfigHash = (Get-FileHash -LiteralPath $appConfigSentinel).Hash
    Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=1 /D=$selected"
    $cli = Join-Path $selected 'trex-agent.exe'
    Assert-True (Test-Path -LiteralPath $cli) 'Explicitly selected CLI is missing.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $selected 'trex-agent.payload'))) 'Selected payload was left installed.'
    Assert-True ((Get-Choice) -eq 1) 'Selected choice was not persisted.'
    $cliHash = (Get-FileHash -LiteralPath $cli).Hash
    Assert-True ($cliHash -eq $payloadHash) 'Installed CLI differs from the freshly staged binary.'
    Invoke-Isolated $cli '--version'
    Write-Output "PASS selected installation: sibling CLI present, payload removed, preference=1, SHA256=$cliHash."

    # A fresh target also tests that preservation is based on the preference,
    # rather than merely detecting an executable left in the target directory.
    $preserved = Join-Path $testRoot 'preserved-selected'
    Invoke-Isolated $installer "/S /NS /UPDATE /D=$preserved"
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $preserved 'trex-agent.exe')).Hash -eq $cliHash) 'Silent update did not preserve selection.'
    Write-Output 'PASS silent update: previous selection preserved.'

    # Exact destination behavior and existing-byte replacement are significant:
    # a directory named like the EXE must fail, never receive a nested payload.
    [IO.File]::WriteAllText($cli, 'stale executable bytes')
    Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=1 /D=$selected"
    Assert-True ((Get-FileHash -LiteralPath $cli).Hash -eq $cliHash) 'Existing executable was not refreshed.'
    $locked = [IO.File]::Open($cli, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=1 /D=$selected" 2
        Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=0 /D=$selected" 2
        Assert-True ((Get-Choice) -eq 1) 'A failed copy/removal changed the previous choice.'
    } finally { $locked.Dispose() }
    Remove-Item -LiteralPath $cli -Force
    New-Item -ItemType Directory -Path $cli | Out-Null
    Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=1 /D=$selected" 2
    Assert-True (@(Get-ChildItem -LiteralPath $cli -Force).Count -eq 0) 'Payload was copied inside an executable-named directory.'
    Remove-Item -LiteralPath $cli -Force
    Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=1 /D=$selected"
    Write-Output 'PASS replacement, locked executable, and directory collision: exact copy or exit code 2; preference preserved on failure.'

    Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=0 /D=$selected"
    Assert-True (-not (Test-Path -LiteralPath $cli)) 'Explicit uncheck did not remove the CLI.'
    Assert-True ((Get-Choice) -eq 0) 'Explicit uncheck was not persisted.'
    Invoke-Isolated $installer "/S /NS /UPDATE /D=$selected"
    Assert-True (-not (Test-Path -LiteralPath $cli)) 'Silent update re-enabled an unchecked CLI.'
    Assert-True ((Get-FileHash -LiteralPath $profileSentinel).Hash -eq $profileHash) 'Profile sentinel changed.'
    Assert-True ((Get-FileHash -LiteralPath $credentialSentinel).Hash -eq $credentialHash) 'Credential sentinel changed.'
    Write-Output 'PASS explicit uncheck and following silent update: CLI removed, profiles and credentials preserved.'

    Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=invalid /D=$selected" 2
    Assert-True ((Get-Choice) -eq 0) 'Invalid option changed the preference.'
    Write-Output 'PASS invalid unattended option rejected with exit code 2.'

    Invoke-Isolated $installer "/S /NS /UPDATE /TREXCLI=1 /D=$selected"
    Invoke-Isolated (Join-Path $selected 'uninstall.exe') "/S /UPDATE _?=$selected"
    Assert-True (-not (Test-Path -LiteralPath $cli)) 'Uninstall did not remove the CLI.'
    Assert-True ((Get-Choice) -eq 1) 'Update uninstall did not preserve selection.'
    Assert-True ((Get-FileHash -LiteralPath $profileSentinel).Hash -eq $profileHash) 'Uninstall changed profiles.'
    Assert-True ((Get-FileHash -LiteralPath $credentialSentinel).Hash -eq $credentialHash) 'Uninstall changed credentials.'
    Assert-True ((Get-FileHash -LiteralPath $appConfigSentinel).Hash -eq $appConfigHash) 'Update uninstall changed existing application settings.'
    Write-Output 'PASS uninstall/update handoff: CLI removed, choice and profile/credential sentinels preserved.'
    Write-Output 'All isolated full-NSIS installation tests passed; no application or provider was launched.'
} finally {
    # Every recursive target is a verified GUID-specific test root; no live
    # product identity, user configuration, or real Trex installer is touched.
    foreach ($key in @($registryRoot, $productRoot, $uninstallRoot) | Where-Object { $cleanupAllowed }) {
        Assert-True ($key.Contains($identity)) 'Refusing to remove an unverified registry key.'
        $registry.DeleteSubKeyTree($key, $false)
    }
    $registry.Dispose()
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    Assert-True ($resolvedRoot -eq (Join-Path $tempBase $identity)) 'Refusing to remove an unverified temporary tree.'
    if ($cleanupAllowed -and (Test-Path -LiteralPath $resolvedRoot)) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}

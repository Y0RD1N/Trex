#requires -Version 7.0
<#
Synthetic NSIS verification only. Never builds Tauri, reads a production payload,
executes a payload, opens a browser, or reads real profiles/credentials.
#>
param(
    [string]$MakeNsis = (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
    [ValidateRange(5, 120)][int]$ProcessTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This synthetic NSIS harness requires Windows.' }
$sourceDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\installer'))
foreach ($name in @('trex-cli.nsh', 'trex-browser.nsh', 'browser-installer.nsi')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory $name) -PathType Leaf)) {
        throw "Browser hooks are not ready: $name is missing. No installer was compiled or run."
    }
}
$compiler = (Resolve-Path -LiteralPath $MakeNsis).Path
$identity = 'trex-browser-test-' + [Guid]::NewGuid().ToString('N')
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = [IO.Path]::GetFullPath((Join-Path $tempBase $identity))
$registryRoot = "Software\TrexInstallerTests\$identity"
$choiceKey = "$registryRoot\Preferences"
$discoveryKey = "$registryRoot\Discovery"
$uninstallKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$identity"
$registry = $null
$cleanupAllowed = $true
$junctions = [Collections.Generic.List[string]]::new()
$allowedPrograms = @{}
$uninstallerRuns = @{}
$sentinels = @{}
$sourceHashes = @{}
$passes = 0
$utf8 = [Text.UTF8Encoding]::new($false)

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-InTestRoot([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    Assert-True ($full.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) "Unsafe test path: $full"
    return $full
}

function ConvertTo-NsisLiteral([string]$Value) {
    Assert-True (-not $Value.Contains("`r") -and -not $Value.Contains("`n")) 'Newlines are not allowed in NSIS path literals.'
    return $Value.Replace('$', '$$').Replace('"', '$\"')
}

function Assert-NoLinkedAncestor([string]$Path) {
    $full = Assert-InTestRoot $Path
    while ($full.Length -ge $testRoot.Length) {
        $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            Assert-True (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Unexpected reparse ancestor: $full"
        }
        if ($full -eq $testRoot) { break }
        $full = [IO.Path]::GetDirectoryName($full)
    }
}

function New-TestDirectory([string]$Path) {
    $full = Assert-InTestRoot $Path
    [IO.Directory]::CreateDirectory($full) | Out-Null
    return $full
}

function Write-Marker([string]$Path, [string]$Marker) {
    $full = Assert-InTestRoot $Path
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full)) | Out-Null
    # Deliberately not MZ/PE, JavaScript, JSON, credentials, or a runnable binary.
    [IO.File]::WriteAllBytes($full, $utf8.GetBytes("INERT SYNTHETIC FIXTURE $identity : $Marker`n"))
}

function Get-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

function Remove-TestPath([string]$Path) {
    $full = Assert-InTestRoot $Path
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        # Directory.Delete without recursion removes the junction, never its target.
        if ($item.PSIsContainer) { [IO.Directory]::Delete($full) } else { [IO.File]::Delete($full) }
    } else { Remove-Item -LiteralPath $full -Recurse -Force }
}

function Get-RegValue([string]$Key, [string]$Name) {
    $handle = $registry.OpenSubKey($Key)
    if ($null -eq $handle) { return $null }
    try { return $handle.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $handle.Dispose() }
}

function Set-RegValue([string]$Key, [string]$Name, $Value, [Microsoft.Win32.RegistryValueKind]$Kind = 'String') {
    Assert-True ($Key.Contains($identity)) 'Refusing to write a non-test registry key.'
    $handle = $registry.CreateSubKey($Key)
    try { $handle.SetValue($Name, $Value, $Kind) } finally { $handle.Dispose() }
}

function Assert-Choice([int]$Cli, [int]$Browser) {
    Assert-True ((Get-RegValue $choiceKey 'InstallCli') -eq $Cli) "InstallCli was not $Cli."
    Assert-True ((Get-RegValue $choiceKey 'InstallBrowser') -eq $Browser) "InstallBrowser was not $Browser."
}

function Get-TreeSnapshot([string]$Directory) {
    $state = [Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $Directory)) { return '<absent>' }
    $queue = [Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($Directory)
    while ($queue.Count -gt 0) {
        $path = $queue.Dequeue()
        $item = Get-Item -LiteralPath $path -Force
        $relative = [IO.Path]::GetRelativePath($Directory, $path)
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $state.Add("L|$relative|$($item.LinkTarget)")
        } elseif ($item.PSIsContainer) {
            $state.Add("D|$relative")
            foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $queue.Enqueue($child.FullName) }
        } else { $state.Add("F|$relative|$(Get-Hash $path)") }
    }
    return (($state | Sort-Object) -join "`n")
}

function Add-Sentinel([string]$Path) {
    Write-Marker $Path 'preserved user artifact, no real data'
    $sentinels[$Path] = Get-Hash $Path
}

function Assert-Sentinels {
    foreach ($path in $sentinels.Keys) {
        Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Sentinel removed: $path"
        Assert-True ((Get-Hash $path) -eq $sentinels[$path]) "Sentinel bytes changed: $path"
    }
    foreach ($key in @($choiceKey, $discoveryKey, $uninstallKey)) {
        Assert-True ((Get-RegValue $key 'HarnessSentinel') -eq $identity) "Registry sentinel removed: $key"
    }
}

function Pass([string]$Message) {
    Assert-Sentinels
    $script:passes++
    Write-Output "PASS $Message"
}

function Invoke-Bounded([string]$Executable, [string]$Arguments, [int]$ExpectedExit = 0, [switch]$CompilerRun) {
    if (-not $CompilerRun) {
        $Executable = Assert-InTestRoot $Executable
        Assert-NoLinkedAncestor $Executable
        Assert-True ($allowedPrograms.ContainsKey($Executable)) "Refusing to execute a payload or unregistered program: $Executable"
        Assert-True ((Get-Hash $Executable) -eq $allowedPrograms[$Executable]) 'Registered NSIS program changed before execution.'
        Assert-True ((Get-Item -LiteralPath $Executable).LinkType -eq $null) 'Refusing to execute a linked program.'
        Assert-True ($Arguments.StartsWith('/S ', [StringComparison]::Ordinal)) 'Installer must run silently.'
        if ($uninstallerRuns.ContainsKey($Executable)) {
            $run = $uninstallerRuns[$Executable]
            Assert-True ($Arguments -ceq "/S _?=$($run.Target)") 'Uninstaller must run synchronously against its registered private target.'
            $Executable = Assert-InTestRoot $run.Runner
            Assert-NoLinkedAncestor $Executable
            Assert-True ((Get-Hash $Executable) -eq $allowedPrograms[$Executable]) 'Private uninstaller copy changed.'
        }
    }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $testRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment['APPDATA'] = $roaming
    $start.Environment['LOCALAPPDATA'] = $localData
    $start.Environment['TEMP'] = $processTemp
    $start.Environment['TMP'] = $processTemp
    $start.Environment['TREX_HOME'] = $cliHome
    $start.Environment['TREX_BROWSER_HOME'] = $browserHome
    $failureTrace = Join-Path $testRoot 'synthetic-abort.txt'
    if (Test-Path -LiteralPath $failureTrace) { Remove-TestPath $failureTrace }
    # A launch/wait/kill failure preserves isolation until termination is proven.
    $script:cleanupAllowed = $false
    $process = $null
    try {
        $process = [Diagnostics.Process]::Start($start)
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($ProcessTimeoutSeconds * 1000)) {
            $process.Kill($true)
            if (-not $process.WaitForExit(10000)) { throw 'Test process did not terminate; retaining private tree and keys.' }
            $script:cleanupAllowed = $true
            throw "Synthetic NSIS process timed out: $([IO.Path]::GetFileName($Executable))"
        }
        $script:cleanupAllowed = $true
        Assert-True ($stdout.Wait(5000) -and $stderr.Wait(5000)) 'NSIS output streams did not close.'
        $trace = if (Test-Path -LiteralPath $failureTrace) { [IO.File]::ReadAllText($failureTrace) } else { '' }
        $discoveryTrace = if ($null -ne $registry) { Get-RegValue $discoveryKey 'InstallDir' } else { '' }
        Assert-True ($process.ExitCode -eq $ExpectedExit) "NSIS exit $($process.ExitCode), expected $ExpectedExit. $($stdout.Result) $($stderr.Result) $trace Discovery=$discoveryTrace"
    } finally { if ($null -ne $process) { $process.Dispose() } }
}

function Compile-TestInstaller([string]$Script, [string]$Output) {
    Invoke-Bounded $compiler ('/NOCONFIG /INPUTCHARSET UTF8 /OUTPUTCHARSET UTF8 /V2 "' + $Script + '"') 0 -CompilerRun
    Assert-True (Test-Path -LiteralPath $Output -PathType Leaf) 'Synthetic compiler output is missing.'
    $allowedPrograms[(Assert-InTestRoot $Output)] = Get-Hash $Output
}

function Register-Uninstaller([string]$Directory, [string]$Name) {
    $path = Assert-InTestRoot (Join-Path $Directory $Name)
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Missing synthetic NSIS uninstaller: $path"
    $script:allowedPrograms[$path] = Get-Hash $path
    # _?= prevents NSIS from spawning an untracked temporary child. Run an exact
    # private copy so the original uninstaller file can still be deleted.
    $runner = Join-Path $processTemp ('uninstall-run-' + [Guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $path -Destination $runner
    $script:allowedPrograms[$runner] = Get-Hash $runner
    Assert-True ($allowedPrograms[$runner] -eq $allowedPrograms[$path]) 'Uninstaller copy bytes differ.'
    $script:uninstallerRuns[$path] = @{ Runner = $runner; Target = (Assert-InTestRoot $Directory) }
    return $path
}

function Invoke-Optional([string]$Directory, [string]$Flags = '', [int]$ExpectedExit = 0) {
    Invoke-Bounded $optionalSetup "/S $Flags /D=$Directory" $ExpectedExit
}

function Invoke-Standalone([string]$Directory, [int]$ExpectedExit = 0) {
    Invoke-Bounded $standaloneSetup "/S /D=$Directory" $ExpectedExit
}

function Assert-NoPayload([string]$Directory) {
    foreach ($name in @('trex-agent.payload', 'trex-browser.payload', 'trex-browser-runtime.payload', 'trex-browser.exe.previous', 'trex-browser-runtime.previous')) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $Directory $name))) "Inert payload/backup remains: $name"
    }
}

function Assert-Browser([string]$Directory, [bool]$Present) {
    $exe = Join-Path $Directory 'trex-browser.exe'
    $runtime = Join-Path $Directory 'trex-browser-runtime'
    if ($Present) {
        Assert-True ((Get-Hash $exe) -eq (Get-Hash (Join-Path $fixtures 'trex-browser.exe'))) 'Browser marker bytes differ.'
        Assert-True ((Get-TreeSnapshot $runtime) -eq (Get-TreeSnapshot (Join-Path $fixtures 'trex-browser-runtime'))) 'Runtime tree contains missing, changed, or stale files.'
    } else {
        Assert-True (-not (Test-Path -LiteralPath $exe)) 'Browser executable remains after removal/default-off.'
        Assert-True (-not (Test-Path -LiteralPath $runtime)) 'Browser runtime remains after removal/default-off.'
    }
    Assert-NoPayload $Directory
}

function Assert-FailedOptional([string]$Directory, [string]$Flags, [int]$Cli = 0, [int]$Browser = 1) {
    $before = Get-TreeSnapshot $Directory
    Invoke-Optional $Directory $Flags 2
    Assert-True ((Get-TreeSnapshot $Directory) -eq $before) "Failed operation changed existing bytes/tree: $Flags"
    Assert-Choice $Cli $Browser
    Assert-Sentinels
}

function New-TestJunction([string]$Path, [string]$Target) {
    $Path = Assert-InTestRoot $Path
    $Target = Assert-InTestRoot $Target
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
    $junctions.Add($Path)
    Assert-True (((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) 'Could not create synthetic junction.'
}

try {
    Assert-True ($testRoot -eq (Join-Path $tempBase $identity)) 'Invalid GUID-specific temporary root.'
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $owner, [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($testRoot), $acl)
    $actual = [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($testRoot), [Security.AccessControl.AccessControlSections]'Owner, Access')
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    Assert-True ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $owner.Value -and
        $actual.AreAccessRulesProtected -and $rules.Count -eq 1 -and
        $rules[0].IdentityReference.Value -eq $owner.Value -and -not $rules[0].IsInherited -and
        $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $rules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
        $rules[0].InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -and
        $rules[0].PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) 'Test root is not private to the current user.'

    $roaming = New-TestDirectory (Join-Path $testRoot 'roaming-appdata')
    $localData = New-TestDirectory (Join-Path $testRoot 'local-appdata')
    $processTemp = New-TestDirectory (Join-Path $testRoot 'process-temp')
    $cliHome = New-TestDirectory (Join-Path $roaming 'trex-agent')
    $browserHome = New-TestDirectory (Join-Path $roaming 'trex-browser')
    $fixtures = New-TestDirectory (Join-Path $testRoot 'marker-fixtures')
    $copies = New-TestDirectory (Join-Path $testRoot 'copied-hooks')
    $defaultInstall = Join-Path $localData "$identity-default"
    $optionalSetup = Join-Path $testRoot 'synthetic-optional-setup.exe'
    $standaloneSetup = Join-Path $testRoot 'synthetic-standalone-setup.exe'
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    foreach ($key in @($choiceKey, $discoveryKey, $uninstallKey)) { Set-RegValue $key 'HarnessSentinel' $identity }
    $foreignDiscovery = Join-Path $testRoot 'foreign-standalone-owner'
    Set-RegValue $discoveryKey 'InstallDir' $foreignDiscovery
    foreach ($relative in @('trex-browser.exe', 'trex-agent.exe', 'trex-browser-runtime\node.exe', 'trex-browser-runtime\worker.mjs',
        'trex-browser-runtime\package.json', 'trex-browser-runtime\package-lock.json',
        'trex-browser-runtime\node_modules\fixture\nested\marker.bin', 'trex-browser-runtime\ffmpeg\ffmpeg.exe')) {
        Write-Marker (Join-Path $fixtures $relative) $relative
    }
    foreach ($relative in @('profiles\synthetic-profile\Cookies', 'profiles\synthetic-profile\Local State',
        'artifacts\screenshot.png', 'artifacts\recording.webm', 'downloads\marker.bin', 'config.json')) {
        Add-Sentinel (Join-Path $browserHome $relative)
        Add-Sentinel (Join-Path $localData "trex-browser\$relative")
    }
    Add-Sentinel (Join-Path $cliHome 'profiles.json')
    Add-Sentinel (Join-Path $cliHome 'credentials\synthetic-not-a-secret.dpapi')

    # Both hook copies stay together for ${__FILEDIR__} includes. Known folders
    # are resolved by NSIS separately from env, so redirect source tokens too.
    foreach ($name in @('trex-cli.nsh', 'trex-browser.nsh', 'browser-installer.nsi')) {
        $original = Join-Path $sourceDirectory $name
        $sourceHashes[$original] = Get-Hash $original
        $source = [IO.File]::ReadAllText($original)
        Assert-True (-not [regex]::IsMatch($source, '(?im)^\s*(Exec(?:Wait|Shell)?\s|(?:nsExec|ExecDos|ExecCmd)::)')) "Source can launch a program: $name"
        $source = $source.Replace('$LOCALAPPDATA', (ConvertTo-NsisLiteral $localData)).Replace('$APPDATA', (ConvertTo-NsisLiteral $roaming))
        $source = [regex]::Replace($source, '(?m)^(\s*StrCpy \$TrexBrowserFailurePath )([^\r\n]+)', [Text.RegularExpressions.MatchEvaluator]{
            param($match)
            $lineNumber = 1 + [regex]::Matches($source.Substring(0, $match.Index), "`n").Count
            return $match.Groups[1].Value + '"' + $match.Groups[2].Value.Trim('"') + " [synthetic trace ${name}:$lineNumber; " + 'r0=$0 r1=$1 r2=$2]"'
        })
        # Silent NSIS Abort text is otherwise invisible. Preserve the original
        # instruction and capture its message in private diagnostic storage.
        $source = [regex]::Replace($source, '(?m)^(\s*)Abort ("[^\r\n]+")\s*$', [Text.RegularExpressions.MatchEvaluator]{
            param($match)
            $indent = $match.Groups[1].Value
            return $indent + 'FileOpen $9 "' + (ConvertTo-NsisLiteral $testRoot) + '\synthetic-abort.txt" w' + "`r`n" +
                $indent + 'FileWrite $9 ' + $match.Groups[2].Value + "`r`n" + $indent + 'FileClose $9' + "`r`n" + $match.Value
        })
        Assert-True (-not [regex]::IsMatch($source, '\$(?:LOCALAPPDATA|APPDATA)\b')) "Known-folder redirection failed: $name"
        [IO.File]::WriteAllText((Join-Path $copies $name), $source, $utf8)
    }

    $optionalSource = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
SetCompressor /SOLID lzma
!include MUI2.nsh
Name "@IDENTITY@ optional"
OutFile "@OPTIONAL_OUT@"
InstallDir "@DEFAULT@"
!define TREX_CLI_REGISTRY_KEY "@CHOICES@"
!define TREX_BROWSER_REGISTRY_KEY "@DISCOVERY@"
Var PassiveMode
!include "trex-cli.nsh"
Page custom TrexCliPageCreate TrexCliPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  SetRegView 64
  SetShellVarContext current
  StrCpy $PassiveMode 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/P" $1
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  Call TrexCliInitialize
FunctionEnd
Function un.onInit
  SetRegView 64
  SetShellVarContext current
FunctionEnd
Section
  !insertmacro NSIS_HOOK_PREINSTALL
  SetOutPath "$INSTDIR"
  File /oname=trex-agent.payload "@FIXTURES@\trex-agent.exe"
  File /oname=trex-browser.payload "@FIXTURES@\trex-browser.exe"
  SetOutPath "$INSTDIR\trex-browser-runtime.payload"
  File /r "@FIXTURES@\trex-browser-runtime\*"
  SetOutPath "$INSTDIR"
  !insertmacro NSIS_HOOK_POSTINSTALL
  WriteUninstaller "$INSTDIR\uninstall-synthetic.exe"
SectionEnd
Section "Uninstall"
  !insertmacro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\uninstall-synthetic.exe"
  RMDir "$INSTDIR"
SectionEnd
'@
    $replacements = @{
        '@IDENTITY@' = $identity; '@OPTIONAL_OUT@' = $optionalSetup; '@DEFAULT@' = $defaultInstall
        '@CHOICES@' = $choiceKey; '@DISCOVERY@' = $discoveryKey; '@FIXTURES@' = $fixtures
    }
    foreach ($token in $replacements.Keys) { $optionalSource = $optionalSource.Replace($token, (ConvertTo-NsisLiteral $replacements[$token])) }
    $optionalScript = Join-Path $copies 'synthetic-optional.nsi'
    [IO.File]::WriteAllText($optionalScript, $optionalSource, $utf8)
    # Wrapper defines replace every production identity before including the
    # standalone source; only its real install/uninstall logic is exercised.
    $standaloneSource = @'
!define TREX_BROWSER_PAYLOAD_DIR "@FIXTURES@"
!define TREX_BROWSER_OUTFILE "@STANDALONE_OUT@"
!define TREX_BROWSER_VERSION "0.0.0"
!define TREX_BROWSER_REGISTRY_KEY "@DISCOVERY@"
!define TREX_BROWSER_UNINSTALL_KEY "@UNINSTALL@"
!define TREX_CLI_REGISTRY_KEY "@CHOICES@"
!define TREX_BROWSER_PRODUCT_NAME "@IDENTITY@"
!define TREX_BROWSER_DEFAULT_DIR "@DEFAULT@"
!include "browser-installer.nsi"
'@
    $replacements['@STANDALONE_OUT@'] = $standaloneSetup
    $replacements['@UNINSTALL@'] = $uninstallKey
    foreach ($token in $replacements.Keys) { $standaloneSource = $standaloneSource.Replace($token, (ConvertTo-NsisLiteral $replacements[$token])) }
    $standaloneScript = Join-Path $copies 'synthetic-standalone.nsi'
    [IO.File]::WriteAllText($standaloneScript, $standaloneSource, $utf8)
    Compile-TestInstaller $optionalScript $optionalSetup
    Compile-TestInstaller $standaloneScript $standaloneSetup

    $pathBefore = @{}
    foreach ($scope in @('User', 'Machine', 'Process')) { $pathBefore[$scope] = [Environment]::GetEnvironmentVariable('PATH', $scope) }

    $off = Join-Path $testRoot 'optional-fresh-off'
    Invoke-Optional $off '/P'
    Assert-Browser $off $false
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $off 'trex-agent.exe'))) 'Fresh installer opted into CLI.'
    Assert-Choice 0 0
    Pass 'fresh silent/passive install defaults both independent options off'

    $cliOnly = Join-Path $testRoot 'optional-cli-only'
    Invoke-Optional $cliOnly '/TREXCLI=1 /TREXBROWSER=0'
    Assert-Browser $cliOnly $false
    Assert-True ((Get-Hash (Join-Path $cliOnly 'trex-agent.exe')) -eq (Get-Hash (Join-Path $fixtures 'trex-agent.exe'))) 'CLI marker hash differs.'
    Assert-Choice 1 0
    $inheritedCli = Join-Path $testRoot 'optional-inherited-cli'
    Invoke-Optional $inheritedCli
    Assert-Choice 1 0
    Assert-Browser $inheritedCli $false
    Assert-True (Test-Path -LiteralPath (Join-Path $inheritedCli 'trex-agent.exe') -PathType Leaf) 'CLI persistence was lost.'
    Pass 'CLI-only selection persists independently of browser'

    $selected = Join-Path $testRoot 'optional-browser-only'
    Invoke-Optional $selected '/TREXCLI=0 /TREXBROWSER=1'
    Assert-Browser $selected $true
    Assert-Choice 0 1
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $selected 'trex-agent.exe'))) 'Browser selection enabled CLI.'
    $both = Join-Path $testRoot 'optional-both'
    Invoke-Optional $both '/TREXCLI=1'
    Assert-Choice 1 1
    Assert-Browser $both $true
    $inheritedBrowser = Join-Path $testRoot 'optional-inherited-browser'
    Invoke-Optional $inheritedBrowser '/TREXCLI=0'
    Assert-Choice 0 1
    Assert-Browser $inheritedBrowser $true
    Pass 'browser-only and both selections, independent toggles and silent persistence; exact payload hashes'

    foreach ($flag in @('/TREXBROWSER=invalid', '/TREXBROWSER=2', '/TREXBROWSER=', '/TREXCLI=invalid')) {
        Assert-FailedOptional $selected $flag
    }
    Pass 'invalid unattended option values reject without changing bytes or preferences'

    Write-Marker (Join-Path $selected 'trex-browser.exe') 'stale browser executable'
    Write-Marker (Join-Path $selected 'trex-browser-runtime\node.exe') 'stale runtime executable'
    Write-Marker (Join-Path $selected 'trex-browser-runtime\node_modules\obsolete\stale.bin') 'stale dependency'
    Write-Marker (Join-Path $selected 'trex-browser.payload') 'old inert executable'
    Write-Marker (Join-Path $selected 'trex-browser-runtime.payload\node_modules\obsolete\stale.bin') 'old inert dependency'
    Invoke-Optional $selected '/TREXBROWSER=1'
    Assert-Browser $selected $true
    Pass 'upgrade replaces stale executable and complete runtime tree'

    foreach ($relative in @('trex-browser.exe', 'trex-browser-runtime\node_modules\fixture\nested\marker.bin')) {
        $lockedPath = Join-Path $selected $relative
        $lock = [IO.File]::Open($lockedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            Assert-FailedOptional $selected '/TREXCLI=1 /TREXBROWSER=1'
            Assert-FailedOptional $selected '/TREXCLI=1 /TREXBROWSER=0'
            $uninstaller = Register-Uninstaller $selected 'uninstall-synthetic.exe'
            $before = Get-TreeSnapshot $selected
            Invoke-Bounded $uninstaller "/S _?=$selected" 2
            Assert-True ((Get-TreeSnapshot $selected) -eq $before) 'Locked uninstall modified existing assets.'
            Assert-Choice 0 1
        } finally { $lock.Dispose() }
    }
    Pass 'locked browser and nested runtime preserve all bytes and preference on upgrade, opt-out and uninstall'

    # Each collision is separate, so failure cannot be attributed to another one.
    foreach ($name in @('trex-browser.exe', 'trex-browser-runtime', 'trex-browser.payload', 'trex-browser-runtime.payload',
        'trex-browser.exe.previous', 'trex-browser-runtime.previous')) {
        $collision = Join-Path $testRoot ('collision-' + $name.Replace('.', '-'))
        New-TestDirectory $collision | Out-Null
        if ($name -in @('trex-browser-runtime', 'trex-browser-runtime.previous')) {
            Write-Marker (Join-Path $collision $name) 'file in directory destination'
        } elseif ($name -eq 'trex-browser.payload') {
            New-TestDirectory (Join-Path $collision $name) | Out-Null
            Write-Marker (Join-Path $collision "$name\keep.bin") 'directory in file destination'
        } elseif ($name -eq 'trex-browser-runtime.payload') {
            Write-Marker (Join-Path $collision $name) 'file in inert runtime destination'
        } else {
            New-TestDirectory (Join-Path $collision $name) | Out-Null
            Write-Marker (Join-Path $collision "$name\keep.bin") 'reserved directory collision'
        }
        Assert-FailedOptional $collision '/TREXBROWSER=1'
        Assert-FailedOptional $collision '/TREXBROWSER=0'
    }
    Pass 'file/directory collisions and reserved backup names reject without destructive preparation'

    $outside = New-TestDirectory (Join-Path $testRoot 'junction-target')
    Add-Sentinel (Join-Path $outside 'keep.bin')
    foreach ($name in @('trex-browser.exe', 'trex-browser-runtime', 'trex-browser.payload', 'trex-browser-runtime.payload')) {
        $collision = New-TestDirectory (Join-Path $testRoot ('junction-' + $name.Replace('.', '-')))
        New-TestJunction (Join-Path $collision $name) $outside
        Assert-FailedOptional $collision '/TREXBROWSER=1'
        Assert-FailedOptional $collision '/TREXBROWSER=0'
    }
    $nestedLink = Join-Path $selected 'trex-browser-runtime\node_modules\junction'
    New-TestJunction $nestedLink $outside
    Assert-FailedOptional $selected '/TREXBROWSER=1'
    Assert-FailedOptional $selected '/TREXBROWSER=0'
    Remove-TestPath $nestedLink
    $ancestor = Join-Path $testRoot 'junction-install-ancestor'
    New-TestJunction $ancestor $outside
    $before = Get-TreeSnapshot $outside
    foreach ($flag in @('/TREXBROWSER=1', '/TREXBROWSER=0')) {
        Invoke-Optional (Join-Path $ancestor 'new-install') $flag 2
        Assert-True ((Get-TreeSnapshot $outside) -eq $before) 'Ancestor junction target changed.'
        Assert-Choice 0 1
    }
    Pass 'destination, inert payload, nested runtime and ancestor reparse points preserve target bytes'

    Add-Sentinel (Join-Path $selected 'profiles\keep.bin')
    Add-Sentinel (Join-Path $selected 'artifacts\keep.bin')
    Invoke-Optional $selected '/TREXBROWSER=0'
    Assert-Browser $selected $false
    Assert-Choice 0 0
    Invoke-Optional $selected
    Assert-Browser $selected $false
    Assert-Choice 0 0
    Invoke-Optional $selected '/TREXBROWSER=1'
    $uninstaller = Register-Uninstaller $selected 'uninstall-synthetic.exe'
    Invoke-Bounded $uninstaller "/S _?=$selected"
    Assert-Browser $selected $false
    Assert-Choice 0 1
    Assert-True ((Get-RegValue $discoveryKey 'InstallDir') -eq $foreignDiscovery) 'Optional installation/removal changed standalone discovery.'
    Pass 'opt-out and uninstall remove only program assets, preserve choice, profiles, artifacts and registry sentinels'

    # Standalone selection is unconditional and independent of the optional
    # desktop preference, even when that preference currently says off.
    Set-RegValue $choiceKey 'InstallBrowser' 0 'DWord'

    $standalone = Join-Path $testRoot 'standalone-custom'
    # A failed first install must not publish discovery or registration.
    $broken = New-TestDirectory (Join-Path $testRoot 'standalone-failure')
    New-TestDirectory (Join-Path $broken 'trex-browser.exe') | Out-Null
    $discoveryBefore = Get-RegValue $discoveryKey 'InstallDir'
    $registrationBefore = Get-RegValue $uninstallKey 'UninstallString'
    $before = Get-TreeSnapshot $broken
    Invoke-Standalone $broken 2
    Assert-True ((Get-TreeSnapshot $broken) -eq $before) 'Failed standalone install changed existing bytes.'
    Assert-True ((Get-RegValue $discoveryKey 'InstallDir') -eq $discoveryBefore) 'Failed install published discovery.'
    Assert-True ((Get-RegValue $uninstallKey 'UninstallString') -eq $registrationBefore) 'Failed install published registration.'
    Pass 'standalone failure does not publish discovery/registration'

    Invoke-Standalone $standalone
    Assert-Browser $standalone $true
    Assert-True ((Get-RegValue $discoveryKey 'InstallDir') -eq $standalone) 'Standalone /D discovery path differs.'
    Assert-True ((Get-RegValue $uninstallKey 'DisplayName') -eq $identity) 'Standalone registration has a production name.'
    Assert-True ((Get-RegValue $uninstallKey 'InstallLocation') -eq $standalone) 'Standalone registration location differs.'
    $uninstaller = Register-Uninstaller $standalone 'uninstall-trex-browser.exe'
    Assert-True ((Get-RegValue $uninstallKey 'UninstallString').Contains($uninstaller)) 'Standalone uninstaller registration differs.'
    Assert-Choice 0 0
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $standalone 'trex-agent.exe'))) 'Standalone installed CLI.'
    Pass 'standalone /D installs exact browser assets, discovery and own registration'

    Invoke-Bounded $standaloneSetup '/S '
    Assert-Browser $standalone $true
    Assert-True ((Get-RegValue $discoveryKey 'InstallDir') -eq $standalone) 'Standalone without /D did not reuse discovery.'
    Assert-True (-not (Test-Path -LiteralPath $defaultInstall)) 'Discovery reuse installed into the default directory.'
    $uninstaller = Register-Uninstaller $standalone 'uninstall-trex-browser.exe'
    Pass 'standalone without /D reuses its existing discovery directory'

    foreach ($relative in @('trex-browser.exe', 'trex-browser-runtime\node_modules\fixture\nested\marker.bin')) {
        $lock = [IO.File]::Open((Join-Path $standalone $relative), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $before = Get-TreeSnapshot $standalone
            Invoke-Standalone $standalone 2
            Assert-True ((Get-TreeSnapshot $standalone) -eq $before) 'Locked standalone update changed bytes.'
            Invoke-Bounded $uninstaller "/S _?=$standalone" 2
            Assert-True ((Get-TreeSnapshot $standalone) -eq $before) 'Locked standalone uninstall changed bytes.'
            Assert-True ((Get-RegValue $discoveryKey 'InstallDir') -eq $standalone) 'Failed operation changed discovery.'
            Assert-True ((Get-RegValue $uninstallKey 'InstallLocation') -eq $standalone) 'Failed operation changed registration.'
            Assert-Choice 0 0
        } finally { $lock.Dispose() }
    }
    Pass 'standalone locked executable/nested runtime preserve program bytes, preference and registration'

    # A newer standalone install owns shared discovery. Removing an older one
    # must leave the newer discovery and registration intact.
    $newOwner = $defaultInstall
    Invoke-Standalone $newOwner
    Assert-Browser $newOwner $true
    Invoke-Bounded $uninstaller "/S _?=$standalone"
    Assert-Browser $standalone $false
    Assert-True ((Get-RegValue $discoveryKey 'InstallDir') -eq $newOwner) 'Older uninstall erased another install discovery.'
    Assert-True ((Get-RegValue $uninstallKey 'InstallLocation') -eq $newOwner) 'Older uninstall erased another install registration.'
    $newUninstaller = Register-Uninstaller $newOwner 'uninstall-trex-browser.exe'
    Invoke-Bounded $newUninstaller "/S _?=$newOwner"
    Assert-Browser $newOwner $false
    Assert-True ($null -eq (Get-RegValue $discoveryKey 'InstallDir')) 'Owner uninstall did not remove discovery.'
    Assert-True ($null -eq (Get-RegValue $uninstallKey 'UninstallString')) 'Owner uninstall did not remove registration values.'
    Pass 'explicit /D=default overrides custom discovery; older uninstall preserves new ownership and unrelated key values'

    Invoke-Bounded $standaloneSetup '/S '
    Assert-Browser $defaultInstall $true
    Assert-True ((Get-RegValue $discoveryKey 'InstallDir') -eq $defaultInstall) 'Standalone default directory differs.'
    $defaultUninstaller = Register-Uninstaller $defaultInstall 'uninstall-trex-browser.exe'
    Invoke-Bounded $defaultUninstaller "/S _?=$defaultInstall"
    Assert-Browser $defaultInstall $false
    Pass 'standalone default directory and uninstall stay within redirected known folders'

    foreach ($scope in @('User', 'Machine', 'Process')) {
        Assert-True ([Environment]::GetEnvironmentVariable('PATH', $scope) -ceq $pathBefore[$scope]) "$scope PATH changed."
    }
    Pass 'user, machine and process PATH unchanged'
    foreach ($path in $sourceHashes.Keys) {
        Assert-True ((Get-Hash $path) -eq $sourceHashes[$path]) 'Hook/template source changed during testing; rerun against a stable source set.'
        Write-Output "SOURCE SHA256 $([IO.Path]::GetFileName($path)) $($sourceHashes[$path])"
    }
    Write-Output "All $passes synthetic browser installer checks passed. No payload, GUI, production installer or lifecycle harness was executed."
} finally {
    if ($cleanupAllowed) {
        foreach ($junction in $junctions) { Remove-TestPath $junction }
        if ($null -ne $registry) {
            foreach ($key in @($registryRoot, $uninstallKey)) {
                Assert-True ($key.Contains($identity)) 'Refusing to remove a non-test registry key.'
                $registry.DeleteSubKeyTree($key, $false)
            }
        }
        Assert-True ([IO.Path]::GetFullPath($testRoot) -eq (Join-Path $tempBase $identity)) 'Refusing to remove an unverified root.'
        if (Test-Path -LiteralPath $testRoot) {
            Assert-NoLinkedAncestor (Join-Path $testRoot 'cleanup-validation')
            Assert-True (-not (Get-TreeSnapshot $testRoot).Contains("`nL|")) 'Unexpected reparse point remains; refusing recursive cleanup.'
            Remove-Item -LiteralPath $testRoot -Recurse -Force
        }
    } else {
        Write-Warning "A test process could not be proven stopped; retaining $testRoot and GUID test registry keys."
    }
    if ($null -ne $registry) { $registry.Dispose() }
}

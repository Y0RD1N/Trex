#requires -Version 7.0
# Execute the actual harness function with a fake process factory. No process,
# installer, registry key, or filesystem artifact is created by these tests.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scriptPath = Join-Path $PSScriptRoot 'test-trex-installer.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer harness has syntax errors.' }
foreach ($name in @('Assert-True', 'Invoke-Isolated')) {
    $functions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
    if ($functions.Count -ne 1) { throw "Expected exactly one $name function." }
    . ([scriptblock]::Create($functions[0].Extent.Text))
}

class InstallerProcessProbe {
    [bool[]]$WaitResults = @($true)
    [int]$ThrowOnWait = 0
    [bool]$KillThrows = $false
    [int]$WaitCount = 0
    [int]$KillCount = 0
    [int]$ExitCode = 0
    [bool]$Disposed = $false
    [bool] WaitForExit([int]$milliseconds) {
        $this.WaitCount++
        if ($this.ThrowOnWait -eq $this.WaitCount) { throw 'simulated wait failure' }
        return $this.WaitResults[$this.WaitCount - 1]
    }
    [void] Kill([bool]$entireTree) {
        $this.KillCount++
        if ($this.KillThrows) { throw 'simulated kill failure' }
    }
    [void] Dispose() { $this.Disposed = $true }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) 'trex-lifecycle-not-created'
$roaming = Join-Path $testRoot 'roaming'
$localData = Join-Path $testRoot 'local'
$config = Join-Path $roaming 'trex-agent'
$fakeExecutable = Join-Path $testRoot 'fake-never-started.exe'

function Test-Lifecycle([string]$Name, [InstallerProcessProbe]$Probe, [bool]$Throws, [bool]$CanCleanup) {
    $script:probe = $Probe
    $script:cleanupAllowed = $true
    $threw = $false
    try { Invoke-Isolated $fakeExecutable '' 0 { param($info) $script:probe } }
    catch { $threw = $true }
    Assert-True ($threw -eq $Throws) "$Name exception state was wrong."
    Assert-True ($script:cleanupAllowed -eq $CanCleanup) "$Name cleanup state was wrong."
    Assert-True $Probe.Disposed "$Name process handle was not disposed."
    Write-Output "PASS $Name cleanupAllowed=$script:cleanupAllowed."
}

Test-Lifecycle 'normal exit' ([InstallerProcessProbe]::new()) $false $true
$probe = [InstallerProcessProbe]::new(); $probe.WaitResults = @($false, $true)
Test-Lifecycle 'timeout with confirmed termination' $probe $true $true
Assert-True ($probe.KillCount -eq 1 -and $probe.WaitCount -eq 2) 'Timeout did not kill and confirm termination.'
$probe = [InstallerProcessProbe]::new(); $probe.WaitResults = @($false); $probe.KillThrows = $true
Test-Lifecycle 'Kill throws' $probe $true $false
$probe = [InstallerProcessProbe]::new(); $probe.ThrowOnWait = 1
Test-Lifecycle 'initial WaitForExit throws' $probe $true $false
$probe = [InstallerProcessProbe]::new(); $probe.WaitResults = @($false); $probe.ThrowOnWait = 2
Test-Lifecycle 'post-kill WaitForExit throws' $probe $true $false
$probe = [InstallerProcessProbe]::new(); $probe.WaitResults = @($false, $false)
Test-Lifecycle 'post-kill termination unconfirmed' $probe $true $false
$script:cleanupAllowed = $true
$threw = $false
try { Invoke-Isolated $fakeExecutable '' 0 { param($info) throw 'simulated launch failure' } }
catch { $threw = $true }
Assert-True ($threw -and -not $script:cleanupAllowed) 'Launch exception allowed cleanup without confirmed termination.'
Write-Output 'PASS process creation throws cleanupAllowed=False.'

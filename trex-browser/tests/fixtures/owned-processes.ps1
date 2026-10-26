param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('children', 'identities')]
    [string] $Mode,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[1-9][0-9]*(,[1-9][0-9]*)*$')]
    [string] $ProcessIds
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ownedIds = @($ProcessIds.Split(',') | ForEach-Object { [uint32]::Parse($_) })
if ($ownedIds.Count -gt 256) { throw 'Too many scoped process IDs' }
$field = if ($Mode -eq 'children') { 'ParentProcessId' } else { 'ProcessId' }
$filter = ($ownedIds | ForEach-Object { "$field = $_" }) -join ' OR '

# Every query is limited to exact test-owned parent IDs or recorded process IDs.
# Never enumerate browser processes by name or query the entire process table.
$records = @(Get-CimInstance -ClassName Win32_Process -Filter $filter | ForEach-Object {
    [PSCustomObject]@{
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        name = $_.Name
        executablePath = $_.ExecutablePath
        commandLine = $_.CommandLine
        createdAt = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    }
})
ConvertTo-Json -InputObject $records -Compress -Depth 3

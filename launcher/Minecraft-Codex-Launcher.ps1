[CmdletBinding()]
param(
    [ValidateSet('Menu', 'StartAll', 'StartGateway', 'Status', 'StopGateway', 'OpenLauncher', 'RunGateway')]
    [string]$Action = 'Menu',
    [switch]$NoPause
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding
} catch { }

$ScriptPath = $PSCommandPath
$LauncherRoot = $PSScriptRoot
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $LauncherRoot '..'))
$GameDir = if ($env:MC_CODEX_GAME_DIR) { $env:MC_CODEX_GAME_DIR } else { Join-Path $env:APPDATA '.minecraft-codex-1.21.11' }
$GatewayConfigPath = if ($env:MC_CODEX_GATEWAY_CONFIG) { $env:MC_CODEX_GATEWAY_CONFIG } else { Join-Path $RepoRoot '.local\gateway.build.json' }
$ConfiguredDataDir = Join-Path $RepoRoot '.local'
if (Test-Path -LiteralPath $GatewayConfigPath) {
    try {
        $bootstrapConfig = Get-Content -LiteralPath $GatewayConfigPath -Raw | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$bootstrapConfig.dataDir)) {
            $ConfiguredDataDir = [string]$bootstrapConfig.dataDir
            if (-not [System.IO.Path]::IsPathRooted($ConfiguredDataDir)) {
                $ConfiguredDataDir = Join-Path $RepoRoot $ConfiguredDataDir
            }
        }
    } catch { }
}
$TokenPath = Join-Path $ConfiguredDataDir 'gateway-token'
$InstanceConfigPath = Join-Path $GameDir 'config\minecraft-codex.json'
$ModsDir = Join-Path $GameDir 'mods'
$MinecraftDir = Join-Path $env:APPDATA '.minecraft'
$ProfilesPath = Join-Path $MinecraftDir 'launcher_profiles.json'
$LauncherStateDir = if ($env:MC_CODEX_LAUNCHER_STATE_DIR) { $env:MC_CODEX_LAUNCHER_STATE_DIR } else { Join-Path $ConfiguredDataDir 'launcher' }
$GatewayPidPath = Join-Path $LauncherStateDir 'gateway.pid'
$GatewayLogPath = Join-Path $LauncherStateDir 'gateway.log'
$OfficialLauncherAppId = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'
$ProfileId = 'fabric-loader-1.21.11'
$ProfileName = 'Minecraft Codex 1.21.11'

function Write-Title([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('-' * [Math]::Min($Text.Length, 72)) -ForegroundColor DarkCyan
}

function Write-Ok([string]$Text) { Write-Host ('[OK] ' + $Text) -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host ('[!] ' + $Text) -ForegroundColor Yellow }
function Write-Err([string]$Text) { Write-Host ('[X] ' + $Text) -ForegroundColor Red }
function Write-Info([string]$Text) { Write-Host ('    ' + $Text) -ForegroundColor Gray }

function Get-ConfiguredPort {
    $port = 25600
    if (Test-Path -LiteralPath $GatewayConfigPath) {
        try {
            $config = Get-Content -LiteralPath $GatewayConfigPath -Raw | ConvertFrom-Json
            if ($null -ne $config.port) { $port = [int]$config.port }
        } catch { }
    }
    return $port
}

function Test-TcpPort {
    param(
        [int]$Port,
        [int]$TimeoutMs = 500
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($async)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Get-GatewayHealth {
    $result = [pscustomobject]@{
        Ok = $false
        Data = $null
        Error = $null
    }
    if (-not (Test-Path -LiteralPath $TokenPath)) {
        $result.Error = '缺少 .local\gateway-token'
        return $result
    }
    try {
        $token = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
        $port = Get-ConfiguredPort
        $result.Data = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $port) -Headers @{ Authorization = ('Bearer ' + $token) } -TimeoutSec 3
        $result.Ok = [bool]$result.Data.ok
        if (-not $result.Ok) { $result.Error = '健康检查返回 ok=false' }
    } catch {
        $statusCode = $null
        if ($null -ne $_.Exception.Response) {
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { }
        }
        if ($statusCode -eq 401) {
            $result.Error = '端口已占用，但认证失败（token 不匹配）'
        } else {
            $result.Error = $_.Exception.Message
        }
    }
    return $result
}

function Get-JavaHome {
    $toolchains = Join-Path $RepoRoot '.local\toolchains\jdk21'
    $known = Join-Path $toolchains 'jdk-21.0.13.0.2+1'
    if (Test-Path -LiteralPath $known) { return $known }
    if (Test-Path -LiteralPath $toolchains) {
        $candidate = Get-ChildItem -LiteralPath $toolchains -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
        if ($null -ne $candidate) { return $candidate.FullName }
    }
    return $null
}

function Invoke-RunGateway {
    try { $Host.UI.RawUI.WindowTitle = 'Minecraft Codex Gateway - build' } catch { }
    New-Item -ItemType Directory -Path $LauncherStateDir -Force | Out-Null
    $stamp = '[{0}] Starting Minecraft Codex Gateway (build)' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    Add-Content -LiteralPath $GatewayLogPath -Value $stamp -Encoding UTF8
    Write-Host $stamp -ForegroundColor Cyan
    $javaHome = Get-JavaHome
    if ($null -ne $javaHome) {
        $env:JAVA_HOME = $javaHome
        $env:PATH = (Join-Path $javaHome 'bin') + ';' + $env:PATH
    }
    $env:GATEWAY_BACKEND = 'codex'
    $env:GATEWAY_CONFIG = $GatewayConfigPath
    Set-Location -LiteralPath $RepoRoot
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) {
        Add-Content -LiteralPath $GatewayLogPath -Value '[X] npm.cmd not found in PATH.' -Encoding UTF8
        exit 1
    }
    Write-Host 'Codex 执行过程将在此窗口实时显示。' -ForegroundColor Gray
    $logStream = New-Object System.IO.FileStream($GatewayLogPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $writer = New-Object System.IO.StreamWriter($logStream, (New-Object System.Text.UTF8Encoding($false)))
    try {
        & $npm.Source run dev 2>&1 | ForEach-Object {
            $line = [string]$_
            Write-Host $line
            $writer.WriteLine($line)
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $writer.Dispose()
    }
    $exitMessage = '[{0}] Gateway process exited with code {1}.' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $exitCode
    Add-Content -LiteralPath $GatewayLogPath -Value $exitMessage -Encoding UTF8
    Write-Host $exitMessage -ForegroundColor Yellow
    Read-Host 'Gateway 已退出，按 Enter 关闭窗口' | Out-Null
    exit $exitCode
}

function Start-GatewayProcess {
    $port = Get-ConfiguredPort
    if (Test-TcpPort -Port $port) {
        $health = Get-GatewayHealth
        if (-not $health.Ok) {
            throw ('端口 {0} 已被占用，但不是可用的 Build Gateway：{1}。请先停止现有进程。' -f $port, $health.Error)
        }
        if ($health.Data.mode -ne 'build' -or -not $health.Data.writesEnabled) {
            throw ('端口 {0} 上的 Gateway 模式是 {1}，不是 build。请先停止后再启动。' -f $port, $health.Data.mode)
        }
        Write-Ok ('复用已运行的 Gateway（{0}，writesEnabled=true）' -f $health.Data.backend)
        return $health.Data
    }

    if (-not (Test-Path -LiteralPath $GatewayConfigPath)) {
        throw ('缺少 Gateway 配置：{0}' -f $GatewayConfigPath)
    }
    New-Item -ItemType Directory -Path $LauncherStateDir -Force | Out-Null
    if (Test-Path -LiteralPath $GatewayLogPath) {
        try {
            if ((Get-Item -LiteralPath $GatewayLogPath).Length -gt 5MB) {
                Move-Item -LiteralPath $GatewayLogPath -Destination ($GatewayLogPath + '.1') -Force
            }
        } catch { }
    }

    Write-Info '正在打开 Gateway 窗口（Codex 执行过程会实时显示，同时写入 .local\launcher\gateway.log）...'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action RunGateway' -f $ScriptPath
    $process = Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Normal -PassThru
    Set-Content -LiteralPath $GatewayPidPath -Value $process.Id -Encoding ASCII

    $deadline = (Get-Date).AddSeconds(120)
    $lastProgress = Get-Date
    Write-Host '    等待 Build Gateway 就绪' -NoNewline -ForegroundColor Gray
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 800
        if ($process.HasExited) {
            Write-Host ''
            $tail = @(Get-Content -LiteralPath $GatewayLogPath -Tail 25 -ErrorAction SilentlyContinue)
            throw ('Gateway 提前退出（代码 {0}）。日志：{1}{2}{3}' -f $process.ExitCode, $GatewayLogPath, [Environment]::NewLine, ($tail -join [Environment]::NewLine))
        }
        $health = Get-GatewayHealth
        if ($health.Ok -and $health.Data.mode -eq 'build' -and $health.Data.writesEnabled) {
            Write-Host ''
            Write-Ok ('Gateway 已就绪：backend={0}, mode={1}' -f $health.Data.backend, $health.Data.mode)
            return $health.Data
        }
        if (((Get-Date) - $lastProgress).TotalSeconds -ge 2) {
            Write-Host '.' -NoNewline -ForegroundColor Gray
            $lastProgress = Get-Date
        }
    }
    Write-Host ''
    throw ('Gateway 在 120 秒内未就绪。请查看日志：{0}' -f $GatewayLogPath)
}

function Get-ClientReadiness {
    $issues = @()

    if (-not (Test-Path -LiteralPath $InstanceConfigPath)) {
        $issues += ('缺少游戏客户端配置：{0}' -f $InstanceConfigPath)
    } elseif (Test-Path -LiteralPath $TokenPath) {
        try {
            $instanceConfig = Get-Content -LiteralPath $InstanceConfigPath -Raw | ConvertFrom-Json
            $gatewayToken = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
            if ([string]$instanceConfig.token -ne $gatewayToken) {
                $issues += '游戏客户端 token 与 .local\gateway-token 不一致'
            }
        } catch {
            $issues += ('游戏客户端配置无法解析：{0}' -f $_.Exception.Message)
        }
    } else {
        $issues += '缺少 .local\gateway-token；请先启动一次 Gateway'
    }

    if (-not (Test-Path -LiteralPath $ProfilesPath)) {
        $issues += ('缺少官方启动器配置：{0}' -f $ProfilesPath)
    } else {
        try {
            $profiles = Get-Content -LiteralPath $ProfilesPath -Raw | ConvertFrom-Json
            $profileProperty = $profiles.profiles.PSObject.Properties | Where-Object { $_.Name -eq $ProfileId } | Select-Object -First 1
            if ($null -eq $profileProperty) {
                $issues += ('官方启动器中缺少配置：{0}' -f $ProfileName)
            } else {
                $profile = $profileProperty.Value
                if ([string]$profile.name -ne $ProfileName) {
                    $issues += ('启动器配置名称不是“{0}”' -f $ProfileName)
                }
                $profileGameDir = ([string]$profile.gameDir).Replace('/', '\').TrimEnd('\').ToLowerInvariant()
                $expectedGameDir = $GameDir.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
                if ($profileGameDir -ne $expectedGameDir) {
                    $issues += ('启动器配置 gameDir 不正确：{0}' -f $profile.gameDir)
                }
                if ([string]::IsNullOrWhiteSpace([string]$profile.lastVersionId)) {
                    $issues += '启动器配置缺少 lastVersionId'
                }
            }
        } catch {
            $issues += ('官方启动器配置无法解析：{0}' -f $_.Exception.Message)
        }
    }

    if (Test-Path -LiteralPath $ModsDir) {
        if (@(Get-ChildItem -LiteralPath $ModsDir -Filter 'minecraft-codex-companion-*.jar' -File -ErrorAction SilentlyContinue).Count -eq 0) {
            $issues += '游戏实例缺少 minecraft-codex-companion JAR'
        }
        if (@(Get-ChildItem -LiteralPath $ModsDir -Filter 'fabric-api-*.jar' -File -ErrorAction SilentlyContinue).Count -eq 0) {
            $issues += '游戏实例缺少 fabric-api JAR'
        }
        if (@(Get-ChildItem -LiteralPath $ModsDir -Filter 'mcpfabric-*.jar' -File -ErrorAction SilentlyContinue).Count -eq 0) {
            $issues += '游戏实例缺少 mcpfabric JAR'
        }
    } else {
        $issues += ('缺少游戏 mods 目录：{0}' -f $ModsDir)
    }

    try {
        $app = Get-StartApps | Where-Object { $_.AppID -eq $OfficialLauncherAppId } | Select-Object -First 1
        if ($null -eq $app) { $issues += '未找到 Minecraft 官方启动器' }
    } catch {
        $issues += ('无法查询 Minecraft 官方启动器：{0}' -f $_.Exception.Message)
    }

    if (Test-Path -LiteralPath $GatewayConfigPath) {
        try {
            $gatewayConfig = Get-Content -LiteralPath $GatewayConfigPath -Raw | ConvertFrom-Json
            if ($null -ne $gatewayConfig.world -and $gatewayConfig.world.enabled -and -not [string]::IsNullOrWhiteSpace([string]$gatewayConfig.world.mcpServerPath)) {
                if (-not (Test-Path -LiteralPath ([string]$gatewayConfig.world.mcpServerPath))) {
                    $issues += ('MCP Server 入口不存在：{0}' -f $gatewayConfig.world.mcpServerPath)
                }
            }
        } catch {
            $issues += ('Gateway 配置无法解析：{0}' -f $_.Exception.Message)
        }
    }

    return $issues
}

function Open-OfficialLauncher {
    $app = Get-StartApps | Where-Object { $_.AppID -eq $OfficialLauncherAppId } | Select-Object -First 1
    if ($null -eq $app) { throw '未找到 Minecraft 官方启动器，请确认 Microsoft Store 版本已安装。' }
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\{0}' -f $OfficialLauncherAppId)
    Write-Ok '已打开 Minecraft 官方启动器'
}

function Show-Status {
    Write-Title 'Minecraft Codex 状态'
    $port = Get-ConfiguredPort
    if (Test-TcpPort -Port $port) {
        $health = Get-GatewayHealth
        if ($health.Ok) {
            Write-Ok ('Gateway 运行中：127.0.0.1:{0}，backend={1}，mode={2}，writesEnabled={3}' -f $port, $health.Data.backend, $health.Data.mode, $health.Data.writesEnabled)
        } else {
            Write-Err ('端口 {0} 已监听，但健康检查失败：{1}' -f $port, $health.Error)
        }
    } else {
        Write-Warn ('Gateway 未运行（端口 {0}）' -f $port)
    }

    $issues = @(Get-ClientReadiness)
    if ($issues.Count -eq 0) {
        Write-Ok ('客户端配置就绪：{0}' -f $ProfileName)
    } else {
        Write-Warn '客户端配置存在以下问题：'
        foreach ($issue in $issues) { Write-Info ('- ' + $issue) }
    }
    if (Test-Path -LiteralPath $GatewayConfigPath) {
        try {
            $statusConfig = Get-Content -LiteralPath $GatewayConfigPath -Raw | ConvertFrom-Json
            if ($null -ne $statusConfig.codex -and $null -ne $statusConfig.codex.permissions) {
                Write-Info ('Codex 权限：localFiles={0}，network={1}' -f $statusConfig.codex.permissions.localFiles, $statusConfig.codex.permissions.network)
            }
        } catch { }
    }
    Write-Info ('游戏目录：{0}' -f $GameDir)
    Write-Info ('Gateway 日志：{0}' -f $GatewayLogPath)
}

function Invoke-StartAll {
    Write-Title '启动 Minecraft Codex'
    $health = Start-GatewayProcess
    $issues = @(Get-ClientReadiness)
    if ($issues.Count -gt 0) {
        Write-Err 'Gateway 已启动，但游戏客户端配置未通过检查，因此没有打开启动器：'
        foreach ($issue in $issues) { Write-Info ('- ' + $issue) }
        return $false
    }
    Open-OfficialLauncher
    Write-Host ''
    Write-Ok 'Gateway 和官方启动器已启动。'
    Write-Info ('请在启动器中选择“{0}”并点击“Play”。' -f $ProfileName)
    Write-Info '进入单人世界后，在聊天栏输入：@codex 你好'
    Write-Info 'Codex 执行过程显示在单独的 Gateway 窗口；关闭启动器窗口不会停止 Gateway。'
    return $true
}

function Get-GatewayPortOwnerPid {
    param([int]$Port)
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $connection) { return 0 }
    return [int]$connection.OwningProcess
}

function Find-LegacyGatewayRootPid {
    param([int]$Port)
    $ownerPid = Get-GatewayPortOwnerPid -Port $Port
    if ($ownerPid -le 0) { return 0 }
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $ownerPid) -ErrorAction SilentlyContinue
    if ($null -eq $owner -or $owner.Name -notmatch '^node(\.exe)?$' -or [string]$owner.CommandLine -notmatch 'packages[/\\]gateway[/\\]dist[/\\]index\.js') {
        return 0
    }

    $legacyStarter = Join-Path $GameDir 'Start-Gateway-Build.cmd'
    $currentPid = [int]$owner.ParentProcessId
    for ($depth = 0; $depth -lt 7 -and $currentPid -gt 0; $depth++) {
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $currentPid) -ErrorAction SilentlyContinue
        if ($null -eq $process) { break }
        $commandLine = [string]$process.CommandLine
        if ($process.Name -match '^cmd(\.exe)?$' -and $commandLine.IndexOf($legacyStarter, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $currentPid
        }
        $currentPid = [int]$process.ParentProcessId
    }
    return 0
}

function Stop-GatewayProcess {
    $port = Get-ConfiguredPort
    if (-not (Test-Path -LiteralPath $GatewayPidPath)) {
        if (Test-TcpPort -Port $port) {
            $health = Get-GatewayHealth
            $legacyRootPid = 0
            if ($health.Ok -and $health.Data.mode -eq 'build') {
                $legacyRootPid = Find-LegacyGatewayRootPid -Port $port
            }
            if ($legacyRootPid -gt 0) {
                Write-Info ('识别到本游戏实例的旧 Build 启动链，正在停止（PID {0}）...' -f $legacyRootPid)
                & taskkill.exe /PID $legacyRootPid /T /F 2>$null | Out-Null
                Start-Sleep -Milliseconds 800
                if (Test-TcpPort -Port $port) {
                    Write-Err 'Gateway 端口仍在监听，请查看日志或手动处理。'
                    return $false
                }
                Write-Ok 'Gateway 已停止'
                return $true
            }
            Write-Warn '检测到 Gateway，但无法确认它属于本游戏实例。为避免误杀，请从原来的 Gateway 窗口停止。'
            return $false
        }
        Write-Ok 'Gateway 未运行'
        return $true
    }

    $gatewayPid = 0
    try { $gatewayPid = [int]((Get-Content -LiteralPath $GatewayPidPath -Raw).Trim()) } catch { }
    $process = $null
    if ($gatewayPid -gt 0) {
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $gatewayPid) -ErrorAction SilentlyContinue
    }
    if ($null -eq $process) {
        Remove-Item -LiteralPath $GatewayPidPath -Force -ErrorAction SilentlyContinue
        if (Test-TcpPort -Port $port) {
            Write-Warn '记录的 Gateway 进程已退出，但端口仍被占用。请手动检查。'
            return $false
        }
        Write-Ok 'Gateway 未运行'
        return $true
    }

    $commandLine = [string]$process.CommandLine
    if ($process.Name -notmatch '^powershell(\.exe)?$' -or $commandLine -notmatch 'Minecraft-Codex-Launcher\.ps1' -or $commandLine -notmatch '-Action\s+RunGateway') {
        Write-Err 'PID 文件指向的不是本启动器进程，已拒绝停止。'
        return $false
    }

    Write-Info ('正在停止 Gateway 进程树（PID {0}）...' -f $gatewayPid)
    & taskkill.exe /PID $gatewayPid /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 800
    Remove-Item -LiteralPath $GatewayPidPath -Force -ErrorAction SilentlyContinue
    if (Test-TcpPort -Port $port) {
        Write-Err 'Gateway 端口仍在监听，请查看日志或手动处理。'
        return $false
    }
    Write-Ok 'Gateway 已停止'
    return $true
}

function Open-GatewayLog {
    if (-not (Test-Path -LiteralPath $GatewayLogPath)) {
        Write-Warn ('日志尚不存在：{0}' -f $GatewayLogPath)
        return
    }
    Start-Process -FilePath 'notepad.exe' -ArgumentList ('"{0}"' -f $GatewayLogPath)
}

function Open-GatewayTraceWindow {
    if (-not (Test-Path -LiteralPath $GatewayLogPath)) {
        Write-Warn ('日志尚不存在：{0}' -f $GatewayLogPath)
        return
    }
    $traceCommand = "Get-Content -LiteralPath '{0}' -Wait -Tail 100" -f $GatewayLogPath.Replace("'", "''")
    Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -NoExit -Command "{0}"' -f $traceCommand.Replace('"', '`"')) -WindowStyle Normal
}

function Invoke-Menu {
    while ($true) {
        Show-Status
        Write-Title '操作'
        Write-Host '  [1] 启动 Gateway + Minecraft 官方启动器'
        Write-Host '  [2] 仅启动 Gateway'
        Write-Host '  [3] 刷新状态'
        Write-Host '  [4] 打开 Minecraft 官方启动器'
        Write-Host '  [5] 停止本启动器启动的 Gateway'
        Write-Host '  [6] 打开实时 Codex 执行窗口'
        Write-Host '  [7] 用记事本打开 Gateway 日志'
        Write-Host '  [0] 退出'
        $choice = Read-Host '请选择'
        try {
            switch ($choice) {
                '1' { Invoke-StartAll | Out-Null }
                '2' { Start-GatewayProcess | Out-Null }
                '3' { }
                '4' { Open-OfficialLauncher }
                '5' {
                    $confirm = Read-Host '确认停止 Gateway？正在执行的任务会被中断 (y/N)'
                    if ($confirm -match '^(y|yes)$') { Stop-GatewayProcess | Out-Null }
                }
                '6' { Open-GatewayTraceWindow }
                '7' { Open-GatewayLog }
                '0' { return }
                default { Write-Warn '请输入 0-7。' }
            }
        } catch {
            Write-Err $_.Exception.Message
        }
        Write-Host ''
    }
}

try {
    switch ($Action) {
        'RunGateway' { Invoke-RunGateway }
        'StartGateway' { Start-GatewayProcess | Out-Null }
        'StartAll' { Invoke-StartAll | Out-Null }
        'Status' { Show-Status }
        'StopGateway' { Stop-GatewayProcess | Out-Null }
        'OpenLauncher' { Open-OfficialLauncher }
        'Menu' { Invoke-Menu }
    }
} catch {
    Write-Err $_.Exception.Message
    if (-not $NoPause) {
        Write-Host ''
        Read-Host '按 Enter 关闭'
    }
    exit 1
}

if ($Action -eq 'StartAll') {
    Write-Host ''
    Write-Info '提示：游戏内人工验收时，先进入一个单人世界，再输入 @codex。'
}

if (-not $NoPause -and $Action -ne 'Menu' -and $Action -ne 'RunGateway') {
    Write-Host ''
    Read-Host '按 Enter 关闭此窗口'
}
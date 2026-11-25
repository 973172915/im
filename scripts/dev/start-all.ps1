# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    一键启动灵犀 IM 的全部本地服务。

.DESCRIPTION
    依次启动（已在运行则跳过）：
      9880  GPT-SoVITS 音色服务（CPU 加载约 4 分钟，最先启动）
      9100  语音合成服务（sovits 引擎，失败自动回退 edge-tts）
      9000  端侧推理 device（MNN 4B int4）
      9200  ai-gateway（无状态推理网关）
      3003  chat-service（Socket.io）
      3000  Next.js 前端

.EXAMPLE
    .\scripts\dev\start-all.ps1
    .\scripts\dev\start-all.ps1 -SkipVoice     # 不起语音
#>
param(
    [string]$Root     = (Resolve-Path "$PSScriptRoot\..\..").Path,
    [string]$Gsv      = "F:\GPT-SoVITS",
    [string]$VoicePy  = "F:\voice_sovits\Scripts\python.exe",
    [string]$MainPy   = "F:\im-llm-assistant\.venv\Scripts\python.exe",
    [switch]$SkipVoice,
    [switch]$SkipSovits,
    [int]$TimeoutSec  = 300
)

$ErrorActionPreference = 'Stop'
$LogDir  = Join-Path $Root 'logs'
$PidFile = Join-Path $Root '.dev-pids.json'
New-Item -ItemType Directory -Force $LogDir | Out-Null

$pids = @{}
if (Test-Path $PidFile) {
    try { $pids = Get-Content $PidFile -Raw | ConvertFrom-Json -AsHashtable } catch { $pids = @{} }
}

function Test-Port([int]$Port) {
    # Get-NetTCPConnection 在部分机器上单次调用要数秒，这里用 TCP 握手探测（毫秒级）
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Wait-Health {
    param([int]$Port, [string]$Name, [int]$Seconds = 20)
    for ($i = 0; $i -lt $Seconds; $i++) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Start-Svc {
    param(
        [string]$Name,
        [int]$Port,
        [string]$File,
        [string[]]$ArgList,
        [string]$WorkDir,
        [hashtable]$Env = @{},
        [int]$WaitSec = 20
    )

    if (Test-Port $Port) {
        Write-Host ("[skip] {0,-14} :{1} 已在运行" -f $Name, $Port) -ForegroundColor DarkGray
        return
    }

    $saved = @{}
    foreach ($k in $Env.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, $Env[$k], 'Process')
    }

    try {
        $out = Join-Path $LogDir "$Name.out.log"
        $err = Join-Path $LogDir "$Name.err.log"
        $p = Start-Process -FilePath $File -ArgumentList $ArgList -WorkingDirectory $WorkDir `
             -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
        $pids[$Name] = $p.Id
        Write-Host ("[start] {0,-14} :{1}  pid={2}" -f $Name, $Port, $p.Id) -ForegroundColor Green
    } finally {
        foreach ($k in $Env.Keys) {
            [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process')
        }
    }

    if (-not (Wait-Health -Port $Port -Name $Name -Seconds $WaitSec)) {
        Write-Host ("[warn] {0,-14} :{1} {2} 秒内未监听，见 logs\{0}.err.log" -f $Name, $Port, $WaitSec) -ForegroundColor Yellow
    }
}

Write-Host "`n=== 灵犀 IM 本地环境 ===`n" -ForegroundColor Cyan

# 1. GPT-SoVITS 音色服务（最慢，先起）
if (-not $SkipVoice -and -not $SkipSovits) {
    if (-not (Test-Path $Gsv)) {
        Write-Host "[skip] sovits 目录不存在: $Gsv" -ForegroundColor DarkGray
    } elseif (-not (Test-Path $VoicePy)) {
        Write-Host "[skip] sovits 环境不存在: $VoicePy" -ForegroundColor DarkGray
    } else {
        Start-Svc -Name 'sovits' -Port 9880 -File $VoicePy `
            -ArgList @('api_v2.py','-a','127.0.0.1','-p','9880','-c','GPT_SoVITS/configs/tts_infer.yaml') `
            -WorkDir $Gsv -Env @{ PYTHONPATH = (Join-Path $Gsv 'GPT_SoVITS') } -WaitSec 5
        Write-Host "        （CPU 加载模型约 4 分钟，可先用其他服务）" -ForegroundColor DarkGray
    }
}

# 2. 语音合成服务
if (-not $SkipVoice) {
    Start-Svc -Name 'tts' -Port 9100 -File $MainPy -ArgList @('server.py') `
        -WorkDir (Join-Path $Root 'services\voice') `
        -Env @{ TTS_ENGINE = 'sovits'; SOVITS_API = 'http://127.0.0.1:9880'; SOVITS_VOICE = 'dafeiyu'; TTS_FALLBACK_EDGE = '1' }
}

# 3. 向量服务（记忆语义召回）
if (-not $SkipVoice) {
    Start-Svc -Name 'embed' -Port 9300 -File $VoicePy -ArgList @('server.py') `
        -WorkDir (Join-Path $Root 'services\embed') `
        -Env @{ EMBED_MODEL_DIR = 'F:\models\bge-small-zh-v1.5' } -WaitSec 40
}

# 3. 端侧推理
Start-Svc -Name 'device' -Port 9000 -File $MainPy `
    -ArgList @('-m','uvicorn','server:app','--host','127.0.0.1','--port','9000') `
    -WorkDir (Join-Path $Root 'services\device') `
    -Env @{
        MNN_MODEL_DIR  = 'F:\mnn-test\qwen3-4b-roleplay-v4-mnn'
        MODEL_ID       = 'qwen3-4b-roleplay'
        MNN_STREAM_EXE = (Join-Path $Root 'services\device\mnn_stream.exe')
    } -WaitSec 40

# 4. 推理网关
Start-Svc -Name 'gateway' -Port 9200 -File $MainPy -ArgList @('app.py') `
    -WorkDir (Join-Path $Root 'services\ai_gateway') `
    -Env @{ INFERENCE_MODE = 'device'; DEVICE_BASE_URL = 'http://127.0.0.1:9000/v1'; DEVICE_MODEL = 'qwen3-4b-roleplay' }

# 5. Socket 服务
$bun = (Get-Command bun.cmd -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = 'bun.cmd' }
Start-Svc -Name 'chat' -Port 3003 -File $bun -ArgList @('run','dev') `
    -WorkDir (Join-Path $Root 'mini-services\chat-service')

# 6. 前端
$next = Join-Path $Root 'node_modules\.bin\next.cmd'
Start-Svc -Name 'web' -Port 3000 -File $next -ArgList @('dev','-p','3000') -WorkDir $Root -WaitSec 40

$pids | ConvertTo-Json | Set-Content $PidFile -Encoding UTF8

Write-Host "`n=== 状态 ===" -ForegroundColor Cyan
$svc = @(
    @{ n='GPT-SoVITS'; p=9880 }, @{ n='TTS'; p=9100 }, @{ n='embed'; p=9300 }, @{ n='device'; p=9000 },
    @{ n='gateway'; p=9200 }, @{ n='chat'; p=3003 }, @{ n='web'; p=3000 }
)
foreach ($s in $svc) {
    $ok = Test-Port $s.p
    $color = if ($ok) { 'Green' } else { 'Red' }
    Write-Host ("  {0,-12} :{1,-5} {2}" -f $s.n, $s.p, $(if ($ok) { 'OK' } else { 'DOWN' })) -ForegroundColor $color
}
Write-Host "`n打开 http://localhost:3000   停止：.\scripts\dev\stop-all.ps1`n" -ForegroundColor Cyan
Write-Host "日志目录：$LogDir`n" -ForegroundColor DarkGray

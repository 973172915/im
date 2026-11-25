# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    停止 start-all.ps1 启动的全部服务。
#>
param(
    [string]$Root = (Resolve-Path "$PSScriptRoot\..\..").Path,
    [switch]$KeepWeb,
    [switch]$KeepSovits
)

$ErrorActionPreference = 'Continue'
$PidFile = Join-Path $Root '.dev-pids.json'
$Ports   = @{ sovits = 9880; tts = 9100; embed = 9300; device = 9000; gateway = 9200; chat = 3003; web = 3000 }

$pids = @{}
if (Test-Path $PidFile) {
    try { $pids = Get-Content $PidFile -Raw | ConvertFrom-Json -AsHashtable } catch { $pids = @{} }
}

$skip = @()
if ($KeepWeb)    { $skip += 'web' }
if ($KeepSovits) { $skip += 'sovits' }

Write-Host "`n=== 停止服务 ===`n" -ForegroundColor Cyan

foreach ($name in $Ports.Keys) {
    if ($skip -contains $name) {
        Write-Host ("[keep] {0,-8} :{1}" -f $name, $Ports[$name]) -ForegroundColor DarkGray
        continue
    }

    $stopped = $false

    # 优先按记录的 PID
    if ($pids.ContainsKey($name) -and $pids[$name]) {
        $p = Get-Process -Id $pids[$name] -ErrorAction SilentlyContinue
        if ($p) {
            try { Stop-Process -Id $p.Id -Force; $stopped = $true } catch { }
        }
    }

    # 兜底：按端口占用
    $conn = Get-NetTCPConnection -LocalPort $Ports[$name] -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn -and $conn.OwningProcess) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -notin @('System', 'svchost')) {
            try { Stop-Process -Id $proc.Id -Force; $stopped = $true } catch { }
        }
    }

    if ($stopped) {
        Write-Host ("[stop] {0,-8} :{1}" -f $name, $Ports[$name]) -ForegroundColor Green
    } else {
        Write-Host ("[none] {0,-8} :{1} 未运行" -f $name, $Ports[$name]) -ForegroundColor DarkGray
    }
}

# 端侧推理的子进程
Get-Process mnn_stream -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force; Write-Host "[stop] mnn_stream" -ForegroundColor Green } catch { }
}

if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 1
Write-Host "`n=== 剩余监听 ===`n" -ForegroundColor Cyan
foreach ($name in $Ports.Keys) {
    $ok = [bool](Get-NetTCPConnection -LocalPort $Ports[$name] -State Listen -ErrorAction SilentlyContinue)
    Write-Host ("  {0,-8} :{1,-5} {2}" -f $name, $Ports[$name], $(if ($ok) { 'STILL UP' } else { 'down' })) -ForegroundColor $(if ($ok) { 'Yellow' } else { 'DarkGray' })
}
Write-Host ""

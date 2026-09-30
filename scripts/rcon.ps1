<#
.SYNOPSIS
  動いている鯖に RCON でコマンドを送る。ふだんは scripts\mc.bat から使う。

.DESCRIPTION
  コマンドを付けるとそれだけ送って終わる。付けないと、続けて入力できるモードになる
  （exit で終了）。鯖名に all を指定すると、動いている鯖すべてに送る。

.EXAMPLE
  scripts\mc.bat lobby whitelist add kanetyyy
  scripts\mc.bat all whitelist add kanetyyy
  scripts\mc.bat s1
#>
param(
    [Parameter(Mandatory = $true)][ValidateSet("lobby", "s1", "c1", "dev", "all")][string]$Server,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Command
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$Ports = [ordered]@{ lobby = 31001; s1 = 31002; c1 = 31003; dev = 31004 }
$password = ([IO.File]::ReadAllText((Join-Path $RepoRoot "run\rcon.secret"))).Trim()
$utf8 = New-Object Text.UTF8Encoding($false)

function Read-Exact($Stream, [int]$Count) {
    $buffer = New-Object byte[] $Count
    $read = 0
    while ($read -lt $Count) {
        $n = $Stream.Read($buffer, $read, $Count - $read)
        if ($n -le 0) { throw "RCON の接続が切れました" }
        $read += $n
    }
    return , $buffer
}

function Invoke-Rcon($Stream, [int]$Id, [int]$Type, [string]$Body) {
    $payload = $utf8.GetBytes($Body)
    $packet = New-Object IO.MemoryStream
    $writer = New-Object IO.BinaryWriter($packet)
    $writer.Write([int](10 + $payload.Length))
    $writer.Write($Id)
    $writer.Write($Type)
    $writer.Write($payload)
    $writer.Write([byte[]](0, 0))
    $bytes = $packet.ToArray()
    $Stream.Write($bytes, 0, $bytes.Length)

    $length = [BitConverter]::ToInt32((Read-Exact $Stream 4), 0)
    $data = Read-Exact $Stream $length
    return @{
        Id   = [BitConverter]::ToInt32($data, 0)
        Body = $utf8.GetString($data, 8, $length - 10)
    }
}

function Connect-Server([string]$Name) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $client.Connect("127.0.0.1", $Ports[$Name])
    } catch {
        throw "$Name に接続できません（止まっている可能性があります。Velocity のコンソールで network start $Name）"
    }
    $stream = $client.GetStream()
    $stream.ReadTimeout = 10000
    if ((Invoke-Rcon $stream 1 3 $password).Id -eq -1) {
        $client.Close()
        throw "RCON のパスワードが違います (run\rcon.secret)"
    }
    return @{ Name = $Name; Client = $client; Stream = $stream }
}

if ($Server -eq "all") {
    $targets = @()
    foreach ($name in $Ports.Keys) {
        try { $targets += Connect-Server $name } catch { }
    }
    if ($targets.Count -eq 0) {
        Write-Host "動いている鯖がありません" -ForegroundColor Red
        exit 1
    }
} else {
    try {
        $targets = @(Connect-Server $Server)
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
}

function Send-ToTargets([string]$Line) {
    foreach ($target in $targets) {
        $body = (Invoke-Rcon $target.Stream 2 2 $Line).Body
        if ($targets.Count -gt 1) { $body = "[$($target.Name)] $body" }
        Write-Host $body
    }
}

try {
    if ($Command) {
        Send-ToTargets ($Command -join " ")
    } else {
        Write-Host "$(($targets | ForEach-Object { $_.Name }) -join ', ') に接続しました。コマンドを入力してください（先頭の / は不要、exit で終了）。"
        while ($true) {
            $line = Read-Host $Server
            if ($null -eq $line -or $line -eq "exit") { break }
            $line = $line.Trim().TrimStart("/")
            if ($line) { Send-ToTargets $line }
        }
    }
} finally {
    foreach ($target in $targets) { $target.Client.Close() }
}

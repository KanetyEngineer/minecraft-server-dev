# Stripe のシークレットキーをクリップボードから Worker に入れる（画面にもファイルにも出さない）
# 使い方: powershell -ExecutionPolicy Bypass -File .\set-stripe-key.ps1
Set-Location $PSScriptRoot
Read-Host "Stripe のシークレットキー（sk_test_ か sk_live_ で始まる）をコピーしてから Enter を押してください" | Out-Null
$key = (Get-Clipboard -Raw)
if ($key) { $key = $key.Trim() }
if ($key -notmatch '^(sk|rk)_(test|live)_[A-Za-z0-9]+$') {
    Write-Host "クリップボードの中身が Stripe のシークレットキーではありません。キーをコピーし直して、もう一度実行してください。" -ForegroundColor Red
    exit 1
}
$mode = if ($key -like '*_test_*') { "テスト" } else { "本番" }
$key | npx wrangler secret put STRIPE_SECRET_KEY
Set-Clipboard -Value " "
Write-Host "$mode 用のキーを入れました（クリップボードは消しました）" -ForegroundColor Green

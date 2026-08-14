$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $repoRoot '.live-auth-postman-runtime'
$expected = Join-Path $repoRoot '.live-auth-postman-runtime'
$pgData = Join-Path $runtime 'postgres'
$pgCtl = 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe'

if ([System.IO.Path]::GetFullPath($runtime) -ne [System.IO.Path]::GetFullPath($expected)) {
  throw "Refusing to stop unexpected runtime path: $runtime"
}

foreach ($name in 'app.pid', 'redis.pid') {
  $path = Join-Path $runtime $name
  if (Test-Path -LiteralPath $path) {
    $processId = [int](Get-Content -LiteralPath $path -Raw)
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

if (Test-Path -LiteralPath $pgData) {
  & $pgCtl -D $pgData -m fast stop
}

if (Test-Path -LiteralPath $runtime) {
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $runtime -Recurse -Force
}


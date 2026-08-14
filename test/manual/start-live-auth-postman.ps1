param(
  [string]$BaseUrl = 'http://127.0.0.1:53015/api/v1'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $repoRoot '.live-auth-postman-runtime'
$pgData = Join-Path $runtime 'postgres'
$pgLog = Join-Path $runtime 'postgres.log'
$appLog = Join-Path $runtime 'app.log'
$redisLog = Join-Path $runtime 'redis.log'
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$postgresPort = 55435
$redisPort = 56382
$appPort = 53015

function Assert-SafeRuntimePath {
  $expected = Join-Path $repoRoot '.live-auth-postman-runtime'
  if ([System.IO.Path]::GetFullPath($runtime) -ne [System.IO.Path]::GetFullPath($expected)) {
    throw "Refusing to clean unexpected runtime path: $runtime"
  }
}

function Wait-ForApi {
  for ($attempt = 1; $attempt -le 90; $attempt += 1) {
    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/health" -TimeoutSec 2
      return
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "Homingo did not become ready. See $appLog"
}

Push-Location $repoRoot
try {
  Assert-SafeRuntimePath
  if (Test-Path -LiteralPath $runtime) {
    throw "Live-auth runtime already exists. Run test/manual/stop-live-auth-postman.ps1 first."
  }
  New-Item -ItemType Directory -Path $runtime | Out-Null

  & (Join-Path $pgBin 'initdb.exe') -D $pgData -U postgres -A trust --no-locale -E UTF8
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l $pgLog -o "-p $postgresPort -h 127.0.0.1" start
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL failed to start' }
  & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p $postgresPort -U postgres homingo_live_auth
  if ($LASTEXITCODE -ne 0) { throw 'createdb failed' }

  $env:NODE_ENV = 'local'
  $env:DATABASE_URL = "postgresql://postgres@127.0.0.1:$postgresPort/homingo_live_auth"
  $env:REDIS_HOST = '127.0.0.1'
  $env:REDIS_PORT = [string]$redisPort
  $env:TEST_REDIS_PORT = [string]$redisPort
  $env:OTP_PROVIDER = 'slide'
  Remove-Item Env:MOCK_OTP_CODE -ErrorAction SilentlyContinue
  $env:JWT_SECRET = 'live-auth-isolated-secret-at-least-32-characters'
  $env:AWS_REGION = 'ap-south-1'
  $env:AWS_S3_BUCKET = 'live-auth-unused'
  $env:AWS_ACCESS_KEY_ID = 'live-auth-unused'
  $env:AWS_SECRET_ACCESS_KEY = 'live-auth-unused'
  $env:COMMISSION_WORKER_ENABLED = 'false'
  $env:RECONCILIATION_ENABLED = 'false'
  $env:PORT = [string]$appPort
  $env:HOST = '127.0.0.1'

  & npx.cmd prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Prisma migrations failed' }

  $redis = Start-Process -FilePath 'node.exe' -ArgumentList 'test/manual/redis-test-server.mjs' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $redisLog -RedirectStandardError (Join-Path $runtime 'redis-error.log')
  Set-Content -LiteralPath (Join-Path $runtime 'redis.pid') -Value $redis.Id

  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Homingo build failed' }
  $app = Start-Process -FilePath 'node.exe' -ArgumentList '--enable-source-maps','dist/src/main.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $appLog -RedirectStandardError (Join-Path $runtime 'app-error.log')
  Set-Content -LiteralPath (Join-Path $runtime 'app.pid') -Value $app.Id
  Wait-ForApi

  Write-Output "Live-auth Homingo is ready at $BaseUrl"
} catch {
  & (Join-Path $PSScriptRoot 'stop-live-auth-postman.ps1') -ErrorAction SilentlyContinue
  throw
} finally {
  Pop-Location
}


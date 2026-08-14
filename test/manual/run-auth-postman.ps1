param(
  [string]$BaseUrl = 'http://127.0.0.1:53014/api/v1'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $repoRoot '.auth-postman-runtime'
$pgData = Join-Path $runtime 'postgres'
$pgLog = Join-Path $runtime 'postgres.log'
$appLog = Join-Path $runtime 'app.log'
$redisLog = Join-Path $runtime 'redis.log'
$newmanReport = Join-Path $runtime 'newman-report.json'
$collection = Join-Path $repoRoot 'postman\Homingo-Full-API.postman_collection.json'
$environment = Join-Path $repoRoot 'postman\Homingo-Local-Isolated.postman_environment.json'
$evidence = Join-Path $repoRoot 'postman\reports\Homingo-Authentication.responses.json'
$summary = Join-Path $repoRoot 'postman\reports\Homingo-Authentication.summary.md'
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$postgresPort = 55434
$redisPort = 56381
$appPort = 53014
$processes = @()
$postgresStarted = $false

function Assert-SafeRuntimePath {
  $expected = Join-Path $repoRoot '.auth-postman-runtime'
  if ([System.IO.Path]::GetFullPath($runtime) -ne [System.IO.Path]::GetFullPath($expected)) {
    throw "Refusing to clean unexpected runtime path: $runtime"
  }
}

function Wait-ForApi {
  for ($attempt = 1; $attempt -le 60; $attempt += 1) {
    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/health" -TimeoutSec 2
      return
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "Homingo did not become ready. See $appLog"
}

function Stop-RunnerProcessTree([int]$RootProcessId) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $ids = [System.Collections.Generic.List[int]]::new()
  $frontier = @($RootProcessId)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($parentId in $frontier) {
      foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parentId }) {
        $ids.Add([int]$child.ProcessId)
        $next += [int]$child.ProcessId
      }
    }
    $frontier = $next
  }
  $orderedIds = @($ids)
  [array]::Reverse($orderedIds)
  foreach ($id in $orderedIds + @($RootProcessId)) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}

Push-Location $repoRoot
try {
  Assert-SafeRuntimePath
  if (Test-Path -LiteralPath $runtime) {
    Remove-Item -LiteralPath $runtime -Recurse -Force
  }
  New-Item -ItemType Directory -Path $runtime | Out-Null

  Write-Host '1/7 Generating the canonical Postman workspace...'
  & node.exe scripts/generate-full-postman.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Postman generation failed' }

  Write-Host '2/7 Initializing disposable PostgreSQL...'
  & (Join-Path $pgBin 'initdb.exe') -D $pgData -U postgres -A trust --no-locale -E UTF8
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l $pgLog -o "-p $postgresPort -h 127.0.0.1" start
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL failed to start' }
  $postgresStarted = $true
  & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p $postgresPort -U postgres homingo_auth_postman
  if ($LASTEXITCODE -ne 0) { throw 'createdb failed' }

  $env:NODE_ENV = 'local'
  $env:DATABASE_URL = "postgresql://postgres@127.0.0.1:$postgresPort/homingo_auth_postman"
  $env:REDIS_HOST = '127.0.0.1'
  $env:REDIS_PORT = [string]$redisPort
  $env:TEST_REDIS_PORT = [string]$redisPort
  $env:OTP_PROVIDER = 'mock'
  $env:MOCK_OTP_CODE = '123456'
  $env:JWT_SECRET = 'auth-postman-isolated-secret-at-least-32-characters'
  $env:AWS_REGION = 'ap-south-1'
  $env:AWS_S3_BUCKET = 'auth-postman-unused'
  $env:AWS_ACCESS_KEY_ID = 'auth-postman-unused'
  $env:AWS_SECRET_ACCESS_KEY = 'auth-postman-unused'
  $env:COMMISSION_WORKER_ENABLED = 'false'
  $env:RECONCILIATION_ENABLED = 'false'
  $env:SWAGGER_ENABLED = 'false'
  $env:PORT = [string]$appPort
  $env:HOST = '127.0.0.1'

  Write-Host '3/7 Applying every database migration...'
  & npx.cmd prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Prisma migrations failed' }

  Write-Host '4/7 Starting the Redis fixture and compiled Homingo server...'
  $processes += Start-Process -FilePath 'node.exe' -ArgumentList 'test/manual/redis-test-server.mjs' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $redisLog -RedirectStandardError (Join-Path $runtime 'redis-error.log')
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Homingo build failed' }
  $processes += Start-Process -FilePath 'node.exe' -ArgumentList '--enable-source-maps','dist/src/main.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $appLog -RedirectStandardError (Join-Path $runtime 'app-error.log')
  Wait-ForApi

  Write-Host '5/7 Running Module 1 in Newman...'
  & npx.cmd --yes newman run $collection -e $environment --folder '01 - Identity, Authentication & Registration' --env-var "baseUrl=$BaseUrl" --reporters cli,json --reporter-json-export $newmanReport --timeout-request 15000
  $newmanExit = $LASTEXITCODE

  Write-Host '6/7 Exporting sanitized request/response evidence...'
  if (Test-Path -LiteralPath $newmanReport) {
    & node.exe test/manual/export-postman-evidence.mjs $newmanReport $evidence $summary 'Homingo Authentication and Registration'
    if ($LASTEXITCODE -ne 0) { throw 'Postman evidence export failed' }
  }

  Write-Host '7/7 Authentication and registration verification complete.'
  if ($newmanExit -ne 0) { throw "Newman reported failed assertions (exit $newmanExit)" }
} finally {
  foreach ($process in $processes) {
    if ($process -and -not $process.HasExited) {
      Stop-RunnerProcessTree $process.Id
    }
  }
  if ($postgresStarted) {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -m fast stop
  }
  Pop-Location
}


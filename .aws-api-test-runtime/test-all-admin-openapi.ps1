param(
  [ValidateSet('readonly', 'item-validation', 'collection-validation')]
  [string]$Mode = 'readonly'
)

$ErrorActionPreference = 'Stop'

$origin = 'http://127.0.0.1:3000'
$base = "$origin/api/v1"
$missingId = '90000000-0000-4000-8000-000000000099'
$fixtures = @{
  cityId = '00000000-0000-4000-9000-000000000001'
  categoryId = '00000000-0000-4000-a000-000000000012'
  serviceId = '00000000-0000-4000-b000-000000000002'
  customerId = 'd522c330-d158-4fcf-9b4d-f6d0f95310f0'
  proId = 'bbbb0000-0000-4000-a000-000000000002'
  bookingId = 'f32b5530-116a-43a4-8b38-a603b8984a07'
  applicationId = '71e75a03-9875-4171-96f7-fafed94584cc'
  areaId = 'fff6a946-eaae-4d9b-bfbc-dfa650fa74e3'
  commissionId = '48d56cad-f223-4194-9a73-03b1e93c3e0a'
  reviewId = '3651b539-31df-4cd7-99a5-ab055814f328'
  adminId = 'd153d157-2ecd-487f-bc8c-bcd07897b2c0'
  roleId = 'c0324bfc-c4f8-4de4-8159-44f32e77c4cd'
}

function New-AdminToken {
  $phone = '+916266941709'
  $request = @{ phone = $phone; actorType = 'admin' } | ConvertTo-Json -Compress
  $sent = ($request | & curl.exe -sS -X POST "$base/auth/otp/request" -H 'Content-Type: application/json' --data-binary '@-') | ConvertFrom-Json
  $otp = node -e "const Redis=require('ioredis');const r=new Redis({host:'127.0.0.1',port:6379,db:1});r.get('otp:'+process.argv[1]).then(v=>{if(v)process.stdout.write(JSON.parse(v).code);return r.quit()})" $phone
  $verify = @{ phone = $phone; actorType = 'admin'; code = $otp; providerRef = $sent.data.providerRef } | ConvertTo-Json -Compress
  $result = ($verify | & curl.exe -sS -X POST "$base/auth/otp/verify" -H 'Content-Type: application/json' --data-binary '@-') | ConvertFrom-Json
  if (-not $result.data.accessToken) { throw 'Could not obtain Admin OTP token' }
  return $result.data.accessToken
}

function New-CustomerToken {
  $customerId = 'd522c330-d158-4fcf-9b4d-f6d0f95310f0'
  return node -e "require('dotenv').config({path:'.env.local',quiet:true});const j=require('jsonwebtoken');process.stdout.write(j.sign({sub:process.argv[1],actorType:'customer',type:'access'},process.env.JWT_SECRET,{expiresIn:'30m'}))" $customerId
}

function Resolve-Schema([object]$schema, [object]$spec) {
  if ($schema.'$ref') {
    $name = ($schema.'$ref' -split '/')[-1]
    return $spec.components.schemas.$name
  }
  return $schema
}

function New-SchemaValue([object]$schema, [object]$spec, [string]$field = '') {
  $schema = Resolve-Schema $schema $spec
  if ($schema.example -ne $null) { return $schema.example }
  if ($schema.enum) { return $schema.enum[0] }
  if ($schema.allOf) {
    $merged = @{}
    foreach ($part in $schema.allOf) {
      $value = New-SchemaValue $part $spec $field
      if ($value -is [hashtable]) { foreach ($key in $value.Keys) { $merged[$key] = $value[$key] } }
    }
    return $merged
  }
  $type = $schema.type
  if (-not $type -and $schema.properties) { $type = 'object' }
  switch ($type) {
    'object' {
      $value = @{}
      foreach ($name in @($schema.required)) {
        if ([string]::IsNullOrWhiteSpace([string]$name)) { continue }
        $property = $schema.properties.$name
        if ($null -eq $property) { continue }
        $value[$name] = New-SchemaValue $property $spec $name
      }
      return $value
    }
    'array' { return @((New-SchemaValue $schema.items $spec $field)) }
    'boolean' { return $true }
    'integer' { if ($schema.minimum -ne $null) { return [int]$schema.minimum }; return 1 }
    'number' { if ($schema.minimum -ne $null) { return [double]$schema.minimum }; return 1 }
    default {
      if ($schema.format -eq 'uuid' -or $field -match 'Id$') { return $missingId }
      if ($schema.format -eq 'date-time') { return '2026-08-14T12:00:00.000Z' }
      if ($schema.format -eq 'date') { return '2026-08-14' }
      if ($schema.format -eq 'email' -or $field -match 'email') { return 'admin-api-test@example.test' }
      if ($field -match 'phone') { return '+919000000099' }
      if ($field -match 'password') { return 'AdminTest#123' }
      if ($field -match 'reason|description|name|note|comment') { return 'AWS cURL API test' }
      if ($field -match 'amount|price|value') { return '1.00' }
      return 'test'
    }
  }
}

function Resolve-Path([string]$template, [string]$method) {
  $path = $template
  $read = $method -eq 'GET'
  $replacements = @{
    docType = 'aadhaar'
    accountId = $missingId
    moduleId = $missingId
    serviceId = $(if ($read) { $fixtures.serviceId } else { $missingId })
    proId = $(if ($read) { $fixtures.proId } else { $missingId })
    id = $missingId
    key = 'aws.curl.test.setting'
  }
  if ($read) {
    if ($path -match '/customers/\{id\}') { $replacements.id = $fixtures.customerId }
    elseif ($path -match '/pros/\{id\}') { $replacements.id = $fixtures.proId }
    elseif ($path -match '/bookings/\{id\}') { $replacements.id = $fixtures.bookingId }
    elseif ($path -match '/pro-applications/\{id\}') { $replacements.id = $fixtures.applicationId }
    elseif ($path -match '/areas/\{id\}') { $replacements.id = $fixtures.areaId }
    elseif ($path -match '/commissions/\{id\}') { $replacements.id = $fixtures.commissionId }
    elseif ($path -match '/reviews/\{id\}') { $replacements.id = $fixtures.reviewId }
    elseif ($path -match '/admin-users/\{id\}') { $replacements.id = $fixtures.adminId }
    elseif ($path -match '/roles/\{id\}') { $replacements.id = $fixtures.roleId }
  }
  foreach ($name in $replacements.Keys) { $path = $path.Replace("{$name}", [string]$replacements[$name]) }
  return $path
}

function Add-RequiredQuery([string]$path, [object]$operation) {
  $pairs = @()
  foreach ($parameter in @($operation.parameters)) {
    if ($parameter.in -ne 'query' -or -not $parameter.required) { continue }
    $value = switch ($parameter.name) {
      'cityId' { $fixtures.cityId }
      'name' { 'Indore, Madhya Pradesh, India' }
      'cellSizeKm' { '2' }
      default { New-SchemaValue $parameter.schema $script:spec $parameter.name }
    }
    $pairs += "$($parameter.name)=$([uri]::EscapeDataString([string]$value))"
  }
  if ($pairs.Count) { return "$path$(if($path.Contains('?')){'&'}else{'?'})$($pairs -join '&')" }
  return $path
}

$dangerous = @(
  '/api/v1/admin/bookings/expire-unpaid',
  '/api/v1/admin/bookings/recurring-plans/run',
  '/api/v1/admin/commissions/recompute-missing',
  '/api/v1/admin/payouts/generate',
  '/api/v1/admin/reconciliation/run',
  '/api/v1/admin/areas/deactivate-outside',
  '/api/v1/admin/areas/generate-grid',
  '/api/v1/admin/areas/generate-grid-for-box',
  '/api/v1/admin/areas/regenerate',
  '/api/v1/admin/areas/suggest-names',
  '/api/v1/admin/bulk-jobs',
  '/api/v1/admin/reports/exports'
)

$safeCollectionOperations = @(
  'AdminAreasController_previewGrid',
  'AdminTrainingController_contentUploadUrl'
)

$adminToken = New-AdminToken
$customerToken = New-CustomerToken
$script:spec = Invoke-RestMethod "$origin/docs/json"
$results = [System.Collections.Generic.List[object]]::new()

foreach ($pathProperty in $spec.paths.PSObject.Properties) {
  $template = $pathProperty.Name
  if ($template -notlike '/api/v1/admin*') { continue }
  foreach ($methodProperty in $pathProperty.Value.PSObject.Properties) {
    $method = $methodProperty.Name.ToUpper()
    if ($method -notin @('GET', 'POST', 'PUT', 'PATCH', 'DELETE')) { continue }
    $operation = $methodProperty.Value
    if ($Mode -eq 'item-validation') {
      if ($method -eq 'GET' -or -not $template.Contains('{')) { continue }
      if ($template -like '/api/v1/admin/platform-settings/*') { continue }
    }
    if ($Mode -eq 'collection-validation') {
      if ($operation.operationId -notin $safeCollectionOperations) { continue }
    }
    $path = Add-RequiredQuery (Resolve-Path $template $method) $operation
    # This exhaustive gate is read-only against AWS: every mutation must stop
    # at the Admin actor/permission guard before controller code can execute.
    # Reversible mutation success paths are covered by the module-specific
    # suites, where exact fixture IDs and cleanup are known in advance.
    $useWrongActor = $Mode -eq 'readonly' -and $method -ne 'GET'
    $token = if ($useWrongActor) { $customerToken } else { $adminToken }
    $args = @('-sS', '-X', $method, "$origin$path", '-H', 'Accept: application/json', '-H', "Authorization: Bearer $token", '-w', "`n__STATUS__%{http_code}")
    $body = $null
    $schema = $operation.requestBody.content.'application/json'.schema
    if ($schema -and -not $useWrongActor) {
      $body = New-SchemaValue $schema $spec
      $args += @('-H', 'Content-Type: application/json')
    }
    if ($operation.operationId -eq 'AdminIncentivesController_create') {
      $body = @{
        name = 'AWS cURL safe validation'
        incentiveType = 'jobs_count'
        criteriaJson = @{ target = 1 }
        rewardAmount = '1.00'
        validFrom = '2026-08-14T00:00:00.000Z'
        cityId = $missingId
      }
    }
    if ($null -ne $body) {
      $json = $body | ConvertTo-Json -Compress -Depth 15
      $raw = $json | & curl.exe @args '--data-binary' '@-'
    } else { $raw = & curl.exe @args }
    $joined = $raw -join "`n"
    if ($joined -notmatch '(?s)^(.*)\n__STATUS__(\d{3})$') { throw "Cannot parse $method $path" }
    $responseText = $Matches[1]
    $status = [int]$Matches[2]
    $response = if ($responseText) { $responseText | ConvertFrom-Json } else { $null }
    $routeMissing = $response -and $response.message -like 'Cannot *'
    $envelopeOk = $status -eq 204 -or ($response -and $response.statusCode -eq $status -and $null -ne $response.success)
    $passed = if ($useWrongActor) {
      $status -eq 403 -and $envelopeOk
    } elseif ($method -eq 'GET') {
      $status -in @(200, 404) -and -not $routeMissing -and $envelopeOk
    } else {
      $status -in @(200, 201, 202, 204, 400, 404, 409, 422) -and -not $routeMissing -and $envelopeOk
    }
    $results.Add([pscustomobject]@{
      method = $method
      path = $path
      operationId = $operation.operationId
      status = $status
      mode = if ($useWrongActor) { 'safe-auth-boundary' } elseif ($method -eq 'GET') { 'seeded-read' } elseif ($template.Contains('{')) { 'valid-body-missing-id' } else { 'validated-collection-action' }
      passed = $passed
      message = $response.message
    })
  }
}

$failed = @($results | Where-Object { -not $_.passed })
[pscustomobject]@{
  mode = $Mode
  total = $results.Count
  passed = $results.Count - $failed.Count
  failed = $failed.Count
  statusCounts = $results | Group-Object status | ForEach-Object { @{ status = $_.Name; count = $_.Count } }
  modeCounts = $results | Group-Object mode | ForEach-Object { @{ mode = $_.Name; count = $_.Count } }
  failures = $failed
  results = $results
} | ConvertTo-Json -Depth 10

if ($failed.Count) { exit 2 }

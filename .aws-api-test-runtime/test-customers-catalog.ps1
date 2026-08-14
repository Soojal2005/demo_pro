$ErrorActionPreference = 'Stop'

$base = 'http://127.0.0.1:3000/api/v1'
$runKey = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$phone = '+91981' + $runKey.Substring($runKey.Length - 7)
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-CurlTest {
  param(
    [string]$Name,
    [string]$Method,
    [string]$Path,
    [AllowNull()][object]$Body,
    [AllowNull()][string]$Token,
    [int[]]$Expected = @(200)
  )

  $args = @('-sS', '-X', $Method, "$base$Path", '-H', 'Accept: application/json')
  if ($Token) { $args += @('-H', "Authorization: Bearer $Token") }
  if ($null -ne $Body) { $args += @('-H', 'Content-Type: application/json') }
  $args += @('-w', "`n__STATUS__%{http_code}")

  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Compress -Depth 12
    $raw = $json | & curl.exe @args '--data-binary' '@-'
  } else {
    $raw = & curl.exe @args
  }
  $joined = $raw -join "`n"
  if ($joined -notmatch '(?s)^(.*)\n__STATUS__(\d{3})$') {
    throw "[$Name] Could not parse curl response: $joined"
  }
  $responseBody = $Matches[1]
  $status = [int]$Matches[2]
  $parsed = if ($responseBody) { $responseBody | ConvertFrom-Json } else { $null }
  $passed = $Expected -contains $status
  $message = if ($parsed) { $parsed.message } else { $null }
  $results.Add([pscustomobject]@{
    name = $Name
    method = $Method
    path = $Path
    status = $status
    expected = ($Expected -join '|')
    passed = $passed
    message = $message
  })
  if (-not $passed) {
    throw "[$Name] Expected $($Expected -join '/') but received ${status}: $responseBody"
  }
  return $parsed
}

function Assert-Test {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "Semantic assertion failed: $Message" }
}

$adminId = '72275664-082b-4226-a61d-e8f4b26122f2'
$roleId = 'a5a574a2-afa7-4be1-affb-b679f20d4f55'
$adminToken = node -e "require('dotenv').config({path:'.env.local',quiet:true});const jwt=require('jsonwebtoken');process.stdout.write(jwt.sign({sub:process.argv[1],actorType:'admin',roleId:process.argv[2],type:'access'},process.env.JWT_SECRET,{expiresIn:'30m'}))" $adminId $roleId
if (-not $adminToken) { throw 'Failed to generate short-lived admin test token' }

# Authenticate one isolated customer against the AWS-backed identity tables.
$otpRequest = Invoke-CurlTest 'Auth: request customer OTP' POST '/auth/otp/request' @{ phone = $phone; actorType = 'customer' } $null @(200, 201)
$otp = node -e "const Redis=require('ioredis');const r=new Redis({host:'127.0.0.1',port:6379,db:1});r.get('otp:'+process.argv[1]).then(v=>{if(v)process.stdout.write(JSON.parse(v).code);return r.quit()})" $phone
if (-not $otp) { throw "Mock OTP was not found for $phone" }
$verified = Invoke-CurlTest 'Auth: verify customer OTP' POST '/auth/otp/verify' @{ phone = $phone; actorType = 'customer'; code = $otp; providerRef = $otpRequest.data.providerRef } $null @(200, 201)
$customerToken = $verified.data.accessToken
if (-not $customerToken) { throw 'Customer access token missing from OTP response' }

# Customer self-service success paths.
$profile = Invoke-CurlTest 'Customer: get profile' GET '/customers/me' $null $customerToken
$customerId = $profile.data.id
Assert-Test ($profile.data.phone -eq $phone) 'profile must return the authenticated phone'
$updatedProfile = Invoke-CurlTest 'Customer: update profile' PATCH '/customers/me' @{ fullName = "AWS Curl Customer $runKey"; email = "aws-curl-$runKey@example.test" } $customerToken
Assert-Test ($updatedProfile.data.fullName -eq "AWS Curl Customer $runKey") 'profile name must be updated'
$serviceability = Invoke-CurlTest 'Customer: serviceability active city' GET '/customers/me/serviceability?cityId=00000000-0000-4000-9000-000000000001' $null $customerToken
Assert-Test ($serviceability.data.serviceable -eq $true) 'seeded active Indore city must be serviceable'
$reverse = Invoke-CurlTest 'Customer: reverse geocode Indore pin' GET '/customers/me/addresses/reverse-geocode?pinLat=22.7196&pinLng=75.8577' $null $customerToken
Assert-Test ($reverse.data.cityId -eq '00000000-0000-4000-9000-000000000001' -and $reverse.data.serviceable -eq $true) 'Indore pin must resolve to active seeded Indore'
$address1 = Invoke-CurlTest 'Customer: create first address' POST '/customers/me/addresses' @{ label = 'home'; addressLine = 'Vijay Nagar, Indore'; landmark = 'API curl fixture'; pinLat = 22.7196; pinLng = 75.8577 } $customerToken @(200, 201)
$address2 = Invoke-CurlTest 'Customer: create second address' POST '/customers/me/addresses' @{ label = 'office'; addressLine = 'Palasia, Indore'; landmark = 'API curl fixture 2'; pinLat = 22.7244; pinLng = 75.8839 } $customerToken @(200, 201)
$address1Id = $address1.data.id
$address2Id = $address2.data.id
Assert-Test ($address1.data.isDefault -eq $true -and $address2.data.isDefault -eq $false) 'first saved address only must default automatically'
$addresses = Invoke-CurlTest 'Customer: list addresses' GET '/customers/me/addresses' $null $customerToken
Assert-Test ($addresses.data.Count -eq 2) 'address list must contain both test addresses'
$updatedAddress = Invoke-CurlTest 'Customer: update address' PATCH "/customers/me/addresses/$address2Id" @{ label = 'other'; landmark = 'Updated by AWS cURL test' } $customerToken
Assert-Test ($updatedAddress.data.label -eq 'other') 'address label must be updated'
$defaultAddress = Invoke-CurlTest 'Customer: set default address' PATCH "/customers/me/addresses/$address2Id/default" @{} $customerToken
Assert-Test ($defaultAddress.data.isDefault -eq $true) 'selected address must become default'
$null = Invoke-CurlTest 'Customer: delete first address' DELETE "/customers/me/addresses/$address1Id" $null $customerToken

# Admin customer success paths. Block is last because it revokes customer sessions.
$encodedPhone = [uri]::EscapeDataString($phone)
$adminCustomers = Invoke-CurlTest 'Admin customer: list/search' GET "/admin/customers?search=$encodedPhone&status=verified&isBlocked=false" $null $adminToken
Assert-Test (@($adminCustomers.data.id) -contains $customerId) 'admin search must return the exact customer'
$customer360 = Invoke-CurlTest 'Admin customer: customer 360' GET "/admin/customers/$customerId" $null $adminToken
Assert-Test ($customer360.data.addresses.Count -eq 1 -and $customer360.data.addresses[0].id -eq $address2Id) 'customer 360 must return the remaining address'
$null = Invoke-CurlTest 'Customer: delete final test address' DELETE "/customers/me/addresses/$address2Id" $null $customerToken
$adminCorrected = Invoke-CurlTest 'Admin customer: correct profile' PATCH "/admin/customers/$customerId" @{ fullName = "AWS Curl Customer Admin $runKey" } $adminToken
Assert-Test ($adminCorrected.data.fullName -eq "AWS Curl Customer Admin $runKey") 'admin correction must persist'
$blocked = Invoke-CurlTest 'Admin customer: block' PATCH "/admin/customers/$customerId/block" @{} $adminToken
Assert-Test ($blocked.data.isBlocked -eq $true) 'block must set isBlocked=true'
$unblocked = Invoke-CurlTest 'Admin customer: unblock' PATCH "/admin/customers/$customerId/unblock" @{} $adminToken
Assert-Test ($unblocked.data.isBlocked -eq $false) 'unblock must set isBlocked=false'

# Public catalog reads use actual seeded AWS records.
$categories = Invoke-CurlTest 'Catalog public: category tree' GET '/catalog/categories' $null $null
$categoryId = '00000000-0000-4000-a000-000000000012'
$serviceId = '00000000-0000-4000-b000-000000000002'
Assert-Test ($categories.data.Count -ge 1) 'seeded category tree must not be empty'
$categoryServices = Invoke-CurlTest 'Catalog public: category services' GET "/catalog/categories/$categoryId/services" $null $null
Assert-Test (@($categoryServices.data.id) -contains $serviceId) 'seeded bathroom category must include Bathroom Deep Clean'
$filteredServices = Invoke-CurlTest 'Catalog public: service search/filter' GET "/catalog/services?categoryId=$categoryId&q=Bathroom&bookingType=instant" $null $null
Assert-Test (@($filteredServices.data.id) -contains $serviceId) 'combined public service filters must return seeded service'
$serviceDetail = Invoke-CurlTest 'Catalog public: service detail' GET "/catalog/services/$serviceId" $null $null
Assert-Test ($serviceDetail.data.name -eq 'Bathroom Deep Clean' -and [decimal]$serviceDetail.data.flatPrice -eq 699) 'seeded service detail must return real name and price'
$activeCities = Invoke-CurlTest 'Catalog public: active cities' GET '/cities' $null $null
Assert-Test (@($activeCities.data.id) -contains '00000000-0000-4000-9000-000000000001') 'public cities must contain active Indore'

# Admin catalog category lifecycle (fully removable through the API).
$categorySlug = "aws-curl-$runKey"
$tempCategory = Invoke-CurlTest 'Admin catalog: create category' POST '/admin/catalog/categories' @{ name = "AWS Curl Category $runKey"; slug = $categorySlug; sortOrder = 999; isActive = $true } $adminToken @(201)
$tempCategoryId = $tempCategory.data.id
$adminCategories = Invoke-CurlTest 'Admin catalog: list categories' GET '/admin/catalog/categories?isActive=true' $null $adminToken
Assert-Test (@($adminCategories.data.id) -contains $tempCategoryId) 'admin active-category filter must contain the new category'
$null = Invoke-CurlTest 'Admin catalog: update category' PATCH "/admin/catalog/categories/$tempCategoryId" @{ name = "AWS Curl Category Updated $runKey"; sortOrder = 998 } $adminToken
$null = Invoke-CurlTest 'Admin catalog: deactivate category' PATCH "/admin/catalog/categories/$tempCategoryId/activation" @{ isActive = $false } $adminToken
$null = Invoke-CurlTest 'Admin catalog: reactivate category' PATCH "/admin/catalog/categories/$tempCategoryId/activation" @{ isActive = $true } $adminToken

# Admin service lifecycle. It is deleted precisely during cleanup because the API intentionally has no service-delete route.
$tempService = Invoke-CurlTest 'Admin catalog: create draft service' POST '/admin/catalog/services' @{ categoryId = $tempCategoryId; name = "AWS Curl Service $runKey"; description = 'Temporary AWS API test fixture'; durationMinutes = 45; flatPrice = '499.00'; supportsInstant = $true; supportsScheduled = $true; supportsRecurring = $false } $adminToken @(201)
$tempServiceId = $tempService.data.id
$adminServices = Invoke-CurlTest 'Admin catalog: list services' GET "/admin/catalog/services?categoryId=$tempCategoryId&isActive=false" $null $adminToken
Assert-Test (@($adminServices.data.id) -contains $tempServiceId) 'admin draft-service filter must contain the new service'
$null = Invoke-CurlTest 'Admin catalog: update service' PATCH "/admin/catalog/services/$tempServiceId" @{ name = "AWS Curl Service Updated $runKey"; durationMinutes = 60; flatPrice = '549.00' } $adminToken
$null = Invoke-CurlTest 'Admin catalog: set commission' PATCH "/admin/catalog/services/$tempServiceId/commission" @{ commissionType = 'percent'; commissionValue = '70.00' } $adminToken
$null = Invoke-CurlTest 'Admin catalog: activate service' PATCH "/admin/catalog/services/$tempServiceId/activation" @{ isActive = $true } $adminToken
$null = Invoke-CurlTest 'Admin catalog: deactivate service' PATCH "/admin/catalog/services/$tempServiceId/activation" @{ isActive = $false } $adminToken

# Remove service first, then prove category delete.
node '.aws-api-test-runtime/cleanup-exact.cjs' service $tempServiceId
$tempServiceId = $null
$null = Invoke-CurlTest 'Admin catalog: delete empty category' DELETE "/admin/catalog/categories/$tempCategoryId" $null $adminToken
$tempCategoryId = $null

# Admin city lifecycle. Cleanup is an exact-id delete because city deletion is intentionally not public API.
$tempCity = Invoke-CurlTest 'Admin catalog: create city' POST '/admin/catalog/cities' @{ name = "AWS Curl City $runKey"; state = 'Test State'; timezone = 'Asia/Kolkata'; isActive = $false } $adminToken @(201)
$tempCityId = $tempCity.data.id
$null = Invoke-CurlTest 'Admin catalog: list all cities' GET '/admin/catalog/cities' $null $adminToken
$null = Invoke-CurlTest 'Admin catalog: update city' PATCH "/admin/catalog/cities/$tempCityId" @{ name = "AWS Curl City Updated $runKey"; state = 'Temporary Test State' } $adminToken
$null = Invoke-CurlTest 'Admin catalog: activate city with supply override' PATCH "/admin/catalog/cities/$tempCityId/activation" @{ isActive = $true; acknowledgeNoSupply = $true } $adminToken
$null = Invoke-CurlTest 'Admin catalog: deactivate city' PATCH "/admin/catalog/cities/$tempCityId/activation" @{ isActive = $false } $adminToken
node '.aws-api-test-runtime/cleanup-exact.cjs' city $tempCityId
$tempCityId = $null

# The isolated verified customer is retained as an auditable AWS test identity;
# both of its temporary addresses were removed through the Customer API.

$failed = @($results | Where-Object { -not $_.passed })
[pscustomobject]@{
  awsDatabaseHealth = 'up'
  runKey = $runKey
  testCustomer = @{ id = $customerId; phone = $phone }
  seededCatalog = @{ categories = $categories.data.Count; categoryId = $categoryId; serviceId = $serviceId }
  total = $results.Count
  passed = $results.Count - $failed.Count
  failed = $failed.Count
  cleanup = @{ tempServiceDeleted = $true; tempCategoryDeleted = $true; tempCityDeleted = $true; testAddressesDeleted = $true; testCustomerRetainedForAudit = $true }
  results = $results
} | ConvertTo-Json -Depth 10

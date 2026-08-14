import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const collectionPath = resolve(
  'postman/Homingo-Full-API.postman_collection.json',
);
const environmentPath = resolve(
  'postman/Homingo-Local-Isolated.postman_environment.json',
);

const jsonHeader = { key: 'Content-Type', value: 'application/json' };

const commonEnvelopeTests = [
  "pm.test('HTTP status matches the documented expectation', function () {",
  "  pm.response.to.have.status(Number(pm.variables.get('expectedStatus')));",
  '});',
  "if (pm.response.code !== 204) {",
  '  const body = pm.response.json();',
  "  pm.test('Response uses the Homingo envelope', function () {",
  "    pm.expect(body).to.be.an('object');",
  "    pm.expect(body).to.have.all.keys('success', 'statusCode', 'message', 'data', 'timestamp', ...(body.errors !== undefined ? ['errors'] : []), ...(body.path !== undefined ? ['path'] : []));",
  '    pm.expect(body.success).to.eql(pm.response.code < 400);',
  '    pm.expect(body.statusCode).to.eql(pm.response.code);',
  "    pm.expect(body.message).to.be.a('string').and.not.empty;",
  "    pm.expect(body.timestamp).to.be.a('string');",
  '    pm.expect(Number.isNaN(Date.parse(body.timestamp))).to.eql(false);',
  '  });',
  "  pm.test('Success data is populated and error data is null', function () {",
  '    if (body.success) pm.expect(body.data).not.to.eql(null);',
  '    else pm.expect(body.data).to.eql(null);',
  '  });',
  '}',
];

function body(value) {
  return {
    mode: 'raw',
    raw: JSON.stringify(value, null, 2),
    options: { raw: { language: 'json' } },
  };
}

function envelope(data, statusCode = 200, message = 'Success') {
  return JSON.stringify(
    {
      success: statusCode < 400,
      statusCode,
      message,
      data: statusCode < 400 ? data : null,
      ...(statusCode >= 400 ? { errors: null } : {}),
      timestamp: '<ISO-8601 timestamp>',
    },
    null,
    2,
  );
}

function exampleResponse(name, code, responseBody, originalRequest) {
  const status = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    429: 'Too Many Requests',
  }[code] ?? 'Response';
  return {
    name,
    originalRequest,
    status,
    code,
    _postman_previewlanguage: 'json',
    header:
      code === 204
        ? []
        : [{ key: 'content-type', value: 'application/json; charset=utf-8' }],
    cookie: [],
    body: responseBody,
  };
}

function requestItem({
  name,
  method = 'POST',
  path,
  requestBody,
  authVariable,
  expectedStatus,
  description,
  tests = [],
  example,
  prerequest = [],
}) {
  // Postman's sandbox already exposes a global `data` binding for iteration
  // data. Declaring `const data` in a request script is therefore a syntax
  // error. Normalize authored snippets to a safely re-declarable local name;
  // `var` also lets tokenTests and the caller share the same payload.
  const normalizedTests = tests.map((line) =>
    line
      .replace(
        'const data = pm.response.json().data;',
        'var responseData = pm.response.json().data;',
      )
      .replace(/(?<!\.)\bdata\./g, 'responseData.'),
  );
  const headers = requestBody === undefined ? [] : [jsonHeader];
  if (authVariable) {
    headers.push({
      key: 'Authorization',
      value: `Bearer {{${authVariable}}}`,
      type: 'text',
    });
  }
  const request = {
    method,
    header: headers,
    ...(requestBody === undefined ? {} : { body: body(requestBody) }),
    url: {
      raw: `{{baseUrl}}${path}`,
      host: ['{{baseUrl}}'],
      path: path.split('/').filter(Boolean),
    },
    description,
  };
  return {
    name,
    ...(prerequest.length
      ? {
          event: [
            {
              listen: 'prerequest',
              script: { type: 'text/javascript', exec: prerequest },
            },
            {
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: [
                  `pm.variables.set('expectedStatus', '${expectedStatus}');`,
                  ...commonEnvelopeTests,
                  ...normalizedTests,
                ],
              },
            },
          ],
        }
      : {
          event: [
            {
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: [
                  `pm.variables.set('expectedStatus', '${expectedStatus}');`,
                  ...commonEnvelopeTests,
                  ...normalizedTests,
                ],
              },
            },
          ],
        }),
    request,
    response: [
      exampleResponse(
        `Expected ${expectedStatus}`,
        expectedStatus,
        example,
        request,
      ),
    ],
  };
}

const tokenTests = (prefix) => [
  'const data = pm.response.json().data;',
  `pm.test('${prefix} token pair is populated', function () {`,
  "  pm.expect(data.accessToken).to.be.a('string').and.not.empty;",
  "  pm.expect(data.refreshToken).to.be.a('string').and.not.empty;",
  '  pm.expect(data.accessToken.split(’.’)).to.have.length(3);',
  '  pm.expect(data.refreshToken.split(’.’)).to.have.length(3);',
  '});',
];

// Use ordinary ASCII quotes in the generated Postman scripts.
function asciiScripts(lines) {
  return lines.map((line) => line.replaceAll('’', "'"));
}

const tokenExample = {
  accessToken: '<redacted JWT access token>',
  refreshToken: '<redacted JWT refresh token>',
};

const authItems = [
  requestItem({
    name: '01 - Health readiness before authentication',
    method: 'GET',
    path: '/health',
    expectedStatus: 200,
    description:
      'Precondition for the module run. Expected: HTTP 200, database status up, memory status up, and no null health payload.',
    tests: [
      'const data = pm.response.json().data;',
      "pm.test('Database and heap checks are healthy', function () {",
      "  pm.expect(data.status).to.eql('ok');",
      "  pm.expect(data.info.database.status).to.eql('up');",
      "  pm.expect(data.info.memory_heap.status).to.eql('up');",
      '});',
    ],
    example: envelope({
      status: 'ok',
      info: { database: { status: 'up' }, memory_heap: { status: 'up' } },
      error: {},
      details: {
        database: { status: 'up' },
        memory_heap: { status: 'up' },
      },
    }),
  }),
  requestItem({
    name: '02 - Reject short guest device identifier',
    path: '/auth/guest-session',
    requestBody: { deviceId: 'short' },
    expectedStatus: 400,
    description:
      'Negative registration contract. deviceId must contain at least 8 characters. Expected: HTTP 400 validation envelope and null data.',
    tests: [
      "pm.test('Validation error explains deviceId failure', function () {",
      '  const body = pm.response.json();',
      "  pm.expect(body.message).to.eql('Validation failed');",
      "  pm.expect(body.errors).to.be.an('array').that.is.not.empty;",
      '});',
    ],
    example: envelope(null, 400, 'Validation failed'),
  }),
  requestItem({
    name: '03 - Create guest registration session',
    path: '/auth/guest-session',
    requestBody: { deviceId: '{{guestDeviceId}}' },
    expectedStatus: 201,
    description:
      'Creates the pre-verification customer used to prove guest-to-verified registration preserves identity. Expected: populated JWT pair.',
    tests: asciiScripts([
      ...tokenTests('Guest'),
      'const data = pm.response.json().data;',
      "pm.environment.set('guestAccessToken', data.accessToken);",
      "pm.environment.set('guestRefreshToken', data.refreshToken);",
    ]),
    example: envelope(tokenExample, 201),
  }),
  requestItem({
    name: '04 - Read guest profile and save registration identity',
    method: 'GET',
    path: '/customers/me',
    authVariable: 'guestAccessToken',
    expectedStatus: 200,
    description:
      'Persistence check for guest registration. phone is intentionally null until OTP verification; id, status, and timestamps must be populated.',
    tests: [
      'const data = pm.response.json().data;',
      "pm.test('Guest profile contains real persisted data', function () {",
      "  pm.expect(data.id).to.be.a('string').and.match(/^[0-9a-f-]{36}$/i);",
      "  pm.expect(data.status).to.eql('guest');",
      '  pm.expect(data.phone).to.eql(null);',
      '  pm.expect(Number.isNaN(Date.parse(data.createdAt))).to.eql(false);',
      '});',
      "pm.environment.set('guestCustomerId', data.id);",
    ],
    example: envelope({
      id: '<persisted customer UUID>',
      phone: null,
      fullName: null,
      email: null,
      status: 'guest',
      defaultAddressId: null,
      createdAt: '<ISO-8601 timestamp>',
      updatedAt: '<ISO-8601 timestamp>',
    }),
  }),
  requestItem({
    name: '05 - Resume the same guest session',
    path: '/auth/guest-session',
    requestBody: { deviceId: '{{guestDeviceId}}' },
    expectedStatus: 201,
    description:
      'Idempotent guest registration check. The same device must resolve to the existing customer, not create an empty duplicate.',
    tests: asciiScripts([
      ...tokenTests('Resumed guest'),
      'const data = pm.response.json().data;',
      "pm.environment.set('guestAccessToken', data.accessToken);",
      "pm.environment.set('guestRefreshToken', data.refreshToken);",
    ]),
    example: envelope(tokenExample, 201),
  }),
  requestItem({
    name: '06 - Reject malformed OTP phone',
    path: '/auth/otp/request',
    requestBody: { phone: '123', actorType: 'customer' },
    expectedStatus: 400,
    description:
      'Rejects a phone that is neither E.164 nor a ten-digit Indian mobile. Expected: HTTP 400 and no provider reference.',
    tests: [
      "pm.test('Malformed phone is rejected by validation', function () {",
      "  pm.expect(pm.response.json().message).to.eql('Validation failed');",
      '});',
    ],
    example: envelope(null, 400, 'Validation failed'),
  }),
  requestItem({
    name: '07 - Reject admin OTP authentication',
    path: '/auth/otp/request',
    requestBody: { phone: '{{customerPhone}}', actorType: 'admin' },
    expectedStatus: 400,
    description:
      'Admins are Firebase-only. This request proves OTP cannot be used as an admin self-registration path.',
    tests: [
      "pm.test('Admin actor type is rejected', function () {",
      "  pm.expect(pm.response.json().message).to.eql('Validation failed');",
      '});',
    ],
    example: envelope(null, 400, 'Validation failed'),
  }),
  requestItem({
    name: '08 - Request customer registration OTP',
    path: '/auth/otp/request',
    requestBody: { phone: '{{customerPhone}}', actorType: 'customer' },
    expectedStatus: 201,
    description:
      'Requests the OTP used to upgrade the guest into a verified customer. The ten-digit input is normalized to +91 before storage/provider use.',
    tests: [
      'const data = pm.response.json().data;',
      "pm.test('Provider reference is non-empty and opaque', function () {",
      "  pm.expect(data.providerRef).to.be.a('string').and.not.empty;",
      '});',
      "pm.environment.set('customerProviderRef', data.providerRef);",
    ],
    example: envelope({ providerRef: '<redacted provider reference>' }, 201),
  }),
  requestItem({
    name: '09 - Reject incorrect customer OTP',
    path: '/auth/otp/verify',
    requestBody: {
      phone: '{{customerPhone}}',
      code: '000000',
      providerRef: '{{customerProviderRef}}',
      actorType: 'customer',
      deviceId: '{{guestDeviceId}}',
    },
    expectedStatus: 401,
    description:
      'Negative OTP verification. Expected: HTTP 401, null data, and no token pair; the valid OTP remains usable within the attempt limit.',
    tests: [
      "pm.test('Incorrect code does not leak tokens', function () {",
      '  const body = pm.response.json();',
      "  pm.expect(body.message).to.eql('Invalid or expired code');",
      '  pm.expect(JSON.stringify(body)).not.to.include("accessToken");',
      '});',
    ],
    example: envelope(null, 401, 'Invalid or expired code'),
  }),
  requestItem({
    name: '10 - Verify OTP and register customer',
    path: '/auth/otp/verify',
    requestBody: {
      phone: '{{customerPhone}}',
      code: '{{mockOtpCode}}',
      providerRef: '{{customerProviderRef}}',
      actorType: 'customer',
      deviceId: '{{guestDeviceId}}',
    },
    expectedStatus: 201,
    description:
      'The actual customer registration operation. A valid OTP upgrades the guest record and returns a new verified token pair.',
    tests: asciiScripts([
      ...tokenTests('Verified customer'),
      'const data = pm.response.json().data;',
      "pm.environment.set('customerAccessToken', data.accessToken);",
      "pm.environment.set('customerRefreshToken', data.refreshToken);",
    ]),
    example: envelope(tokenExample, 201),
  }),
  requestItem({
    name: '11 - Validate persisted verified customer registration',
    method: 'GET',
    path: '/customers/me',
    authVariable: 'customerAccessToken',
    expectedStatus: 200,
    description:
      'Reads registration back from PostgreSQL. Expected: the guest UUID is preserved, phone is normalized to E.164, and status is verified.',
    tests: [
      'const data = pm.response.json().data;',
      "pm.test('Guest was upgraded instead of duplicated', function () {",
      "  pm.expect(data.id).to.eql(pm.environment.get('guestCustomerId'));",
      "  pm.expect(data.phone).to.eql('+91' + pm.environment.get('customerPhone'));",
      "  pm.expect(data.status).to.eql('verified');",
      '});',
      "pm.environment.set('customerId', data.id);",
    ],
    example: envelope({
      id: '<same persisted customer UUID>',
      phone: '+917828241001',
      fullName: null,
      email: null,
      status: 'verified',
      defaultAddressId: null,
      createdAt: '<ISO-8601 timestamp>',
      updatedAt: '<ISO-8601 timestamp>',
    }),
  }),
  requestItem({
    name: '12 - Request OTP for existing-customer login',
    path: '/auth/otp/request',
    requestBody: { phone: '{{customerPhone}}', actorType: 'customer' },
    expectedStatus: 201,
    description:
      'Starts a second OTP flow for the already-registered phone to prove login resumes the same account.',
    tests: [
      'const data = pm.response.json().data;',
      "pm.test('Login request returns provider reference', function () { pm.expect(data.providerRef).to.be.a('string').and.not.empty; });",
      "pm.environment.set('customerLoginProviderRef', data.providerRef);",
    ],
    example: envelope({ providerRef: '<redacted provider reference>' }, 201),
  }),
  requestItem({
    name: '13 - Login existing customer with OTP',
    path: '/auth/otp/verify',
    requestBody: {
      phone: '{{customerPhone}}',
      code: '{{mockOtpCode}}',
      providerRef: '{{customerLoginProviderRef}}',
      actorType: 'customer',
    },
    expectedStatus: 201,
    description:
      'Existing-customer login. Expected: fresh tokens, with no new customer record.',
    tests: asciiScripts([
      ...tokenTests('Existing customer'),
      'const data = pm.response.json().data;',
      "pm.environment.set('customerAccessToken', data.accessToken);",
      "pm.environment.set('customerRefreshToken', data.refreshToken);",
    ]),
    example: envelope(tokenExample, 201),
  }),
  requestItem({
    name: '14 - Confirm existing login resolves the same customer',
    method: 'GET',
    path: '/customers/me',
    authVariable: 'customerAccessToken',
    expectedStatus: 200,
    description:
      'Post-login identity check. The returned persisted UUID must equal the registration UUID.',
    tests: [
      "pm.test('Login did not create a duplicate customer', function () {",
      "  pm.expect(pm.response.json().data.id).to.eql(pm.environment.get('customerId'));",
      '});',
    ],
    example: envelope({
      id: '<same persisted customer UUID>',
      phone: '+917828241001',
      fullName: null,
      email: null,
      status: 'verified',
      defaultAddressId: null,
      createdAt: '<ISO-8601 timestamp>',
      updatedAt: '<ISO-8601 timestamp>',
    }),
  }),
  requestItem({
    name: '15 - Request Pro registration OTP',
    path: '/auth/otp/request',
    requestBody: { phone: '{{proPhone}}', actorType: 'pro' },
    expectedStatus: 201,
    description:
      'Starts Pro registration/login. Customer and Pro identities are isolated even if a caller later chooses the same phone.',
    tests: [
      'const data = pm.response.json().data;',
      "pm.test('Pro provider reference is populated', function () { pm.expect(data.providerRef).to.be.a('string').and.not.empty; });",
      "pm.environment.set('proProviderRef', data.providerRef);",
    ],
    example: envelope({ providerRef: '<redacted provider reference>' }, 201),
  }),
  requestItem({
    name: '16 - Verify OTP and register Pro',
    path: '/auth/otp/verify',
    requestBody: {
      phone: '{{proPhone}}',
      code: '{{mockOtpCode}}',
      providerRef: '{{proProviderRef}}',
      actorType: 'pro',
    },
    expectedStatus: 201,
    description:
      'Creates or resumes a Pro identity and returns a token pair. A first-time Pro starts in applied status.',
    tests: asciiScripts([
      ...tokenTests('Pro'),
      'const data = pm.response.json().data;',
      "pm.environment.set('proAccessToken', data.accessToken);",
      "pm.environment.set('proRefreshToken', data.refreshToken);",
    ]),
    example: envelope(tokenExample, 201),
  }),
  requestItem({
    name: '17 - Validate persisted Pro registration',
    method: 'GET',
    path: '/pros/me',
    authVariable: 'proAccessToken',
    expectedStatus: 200,
    description:
      'Reads the new Pro from PostgreSQL. Required identity/counter fields must be populated; optional onboarding fields may be null.',
    tests: [
      'const data = pm.response.json().data;',
      "pm.test('Pro registration contains real initialized data', function () {",
      "  pm.expect(data.id).to.be.a('string').and.match(/^[0-9a-f-]{36}$/i);",
      "  pm.expect(data.phone).to.eql('+91' + pm.environment.get('proPhone'));",
      "  pm.expect(data.status).to.eql('applied');",
      '  pm.expect(data.ratingSum).to.eql(0);',
      '  pm.expect(data.ratingCount).to.eql(0);',
      '  pm.expect(data.isAvailable).to.eql(false);',
      '});',
      "pm.environment.set('proId', data.id);",
    ],
    example: envelope({
      id: '<persisted Pro UUID>',
      phone: '+917828241002',
      status: 'applied',
      languages: [],
      isAvailable: false,
      ratingSum: 0,
      ratingCount: 0,
      assignmentsOffered: 0,
      assignmentsAcknowledged: 0,
      completedJobs: 0,
      createdAt: '<ISO-8601 timestamp>',
      updatedAt: '<ISO-8601 timestamp>',
      note: 'Other documented onboarding fields are intentionally null.',
    }),
  }),
  requestItem({
    name: '18 - Rotate customer refresh token',
    path: '/auth/refresh',
    requestBody: { refreshToken: '{{customerRefreshToken}}' },
    expectedStatus: 201,
    description:
      'Rotates a valid refresh token. Expected: both returned tokens are new and the old refresh token becomes unusable.',
    tests: asciiScripts([
      'const previous = pm.environment.get("customerRefreshToken");',
      'const data = pm.response.json().data;',
      ...tokenTests('Rotated customer'),
      "pm.test('Refresh token actually rotated', function () { pm.expect(data.refreshToken).not.to.eql(previous); });",
      "pm.environment.set('rotatedCustomerAccessToken', data.accessToken);",
      "pm.environment.set('rotatedCustomerRefreshToken', data.refreshToken);",
      "pm.environment.set('usedCustomerRefreshToken', previous);",
    ]),
    example: envelope(tokenExample, 201),
  }),
  requestItem({
    name: '19 - Reject replay of rotated refresh token',
    path: '/auth/refresh',
    requestBody: { refreshToken: '{{usedCustomerRefreshToken}}' },
    expectedStatus: 401,
    description:
      'Refresh-token theft/replay check. Expected: HTTP 401 and revocation of the account refresh-session family.',
    tests: [
      "pm.test('Replay is explicitly rejected', function () {",
      "  pm.expect(pm.response.json().message).to.eql('Refresh token already used or revoked');",
      '});',
    ],
    example: envelope(null, 401, 'Refresh token already used or revoked'),
  }),
  requestItem({
    name: '20 - Confirm replay revoked the rotated session',
    path: '/auth/refresh',
    requestBody: { refreshToken: '{{rotatedCustomerRefreshToken}}' },
    expectedStatus: 401,
    description:
      'Confirms replay handling revoked all refresh sessions for that customer, not only the already-used token.',
    tests: [
      "pm.test('Rotated session was revoked after replay', function () {",
      "  pm.expect(pm.response.json().message).to.eql('Refresh token already used or revoked');",
      '});',
    ],
    example: envelope(null, 401, 'Refresh token already used or revoked'),
  }),
  requestItem({
    name: '21 - Logout Pro single session',
    path: '/auth/logout',
    requestBody: { refreshToken: '{{proRefreshToken}}' },
    expectedStatus: 204,
    description:
      'Revokes exactly the Pro refresh session. Expected: HTTP 204 with no response body.',
    tests: [
      "pm.test('Logout response is truly bodyless', function () { pm.expect(pm.response.text()).to.eql(''); });",
    ],
    example: '',
  }),
  requestItem({
    name: '22 - Reject refresh after single-session logout',
    path: '/auth/refresh',
    requestBody: { refreshToken: '{{proRefreshToken}}' },
    expectedStatus: 401,
    description:
      'Persistence check for logout. The revoked refresh token must not issue another token pair.',
    tests: [
      "pm.test('Logged-out session cannot refresh', function () {",
      "  pm.expect(pm.response.json().message).to.eql('Refresh token already used or revoked');",
      '});',
    ],
    example: envelope(null, 401, 'Refresh token already used or revoked'),
  }),
  requestItem({
    name: '23 - Request OTP for logout-all session',
    path: '/auth/otp/request',
    requestBody: { phone: '{{sessionPhone}}', actorType: 'customer' },
    expectedStatus: 201,
    description: 'Creates a clean customer session used only for logout-all verification.',
    tests: [
      'const ref = pm.response.json().data.providerRef;',
      "pm.test('Session OTP reference exists', function () { pm.expect(ref).to.be.a('string').and.not.empty; });",
      "pm.environment.set('sessionProviderRef', ref);",
    ],
    example: envelope({ providerRef: '<redacted provider reference>' }, 201),
  }),
  requestItem({
    name: '24 - Verify logout-all customer session',
    path: '/auth/otp/verify',
    requestBody: {
      phone: '{{sessionPhone}}',
      code: '{{mockOtpCode}}',
      providerRef: '{{sessionProviderRef}}',
      actorType: 'customer',
    },
    expectedStatus: 201,
    description: 'Issues the access and refresh tokens used by the logout-all scenario.',
    tests: asciiScripts([
      ...tokenTests('Logout-all customer'),
      'const data = pm.response.json().data;',
      "pm.environment.set('logoutAllAccessToken', data.accessToken);",
      "pm.environment.set('logoutAllRefreshToken', data.refreshToken);",
    ]),
    example: envelope(tokenExample, 201),
  }),
  requestItem({
    name: '25 - Revoke every current customer session',
    path: '/auth/logout-all',
    requestBody: undefined,
    authVariable: 'logoutAllAccessToken',
    expectedStatus: 204,
    description:
      'Revokes every Redis refresh session for the authenticated identity. Expected: HTTP 204 with no body.',
    tests: [
      "pm.test('Logout-all response is bodyless', function () { pm.expect(pm.response.text()).to.eql(''); });",
    ],
    example: '',
  }),
  requestItem({
    name: '26 - Reject refresh after logout-all',
    path: '/auth/refresh',
    requestBody: { refreshToken: '{{logoutAllRefreshToken}}' },
    expectedStatus: 401,
    description:
      'Persistence check for logout-all. The previously active refresh token must be rejected.',
    tests: [
      "pm.test('Logout-all revoked the stored session', function () {",
      "  pm.expect(pm.response.json().message).to.eql('Refresh token already used or revoked');",
      '});',
    ],
    example: envelope(null, 401, 'Refresh token already used or revoked'),
  }),
  requestItem({
    name: '27 - Reject logout-all without bearer token',
    path: '/auth/logout-all',
    expectedStatus: 401,
    description:
      'Authentication guard check. Expected: HTTP 401 Missing bearer token.',
    tests: [
      "pm.test('Missing bearer token is explicit', function () { pm.expect(pm.response.json().message).to.eql('Missing bearer token'); });",
    ],
    example: envelope(null, 401, 'Missing bearer token'),
  }),
  requestItem({
    name: '28 - Reject invalid Firebase admin identity token',
    path: '/auth/admin/firebase-login',
    requestBody: { idToken: 'invalid-firebase-id-token' },
    expectedStatus: 401,
    description:
      'Negative admin-login contract. Firebase verification failure must return 401 and must never create an admin account.',
    tests: [
      "pm.test('Invalid Firebase token is rejected without data', function () {",
      "  pm.expect(pm.response.json().message).to.eql('Invalid or expired identity token');",
      '});',
    ],
    example: envelope(null, 401, 'Invalid or expired identity token'),
  }),
];

for (let attempt = 1; attempt <= 6; attempt += 1) {
  authItems.push(
    requestItem({
      name: `29.${attempt} - OTP request rate limit attempt ${attempt}`,
      path: '/auth/otp/request',
      requestBody: { phone: '{{rateLimitPhone}}', actorType: 'customer' },
      expectedStatus: attempt <= 5 ? 201 : 429,
      description:
        attempt <= 5
          ? `Allowed OTP request ${attempt} of 5 inside the configured window.`
          : 'Sixth OTP request is blocked. Expected: HTTP 429 and no provider reference.',
      tests:
        attempt <= 5
          ? [
              "pm.test('Allowed request returned a provider reference', function () { pm.expect(pm.response.json().data.providerRef).to.be.a('string').and.not.empty; });",
            ]
          : [
              "pm.test('Rate-limit response is explicit', function () { pm.expect(pm.response.json().message).to.include('Too many OTP requests'); });",
            ],
      example:
        attempt <= 5
          ? envelope({ providerRef: '<redacted provider reference>' }, 201)
          : envelope(
              null,
              429,
              'Too many OTP requests for this number - try again later',
            ),
    }),
  );
}

authItems.push(
  requestItem({
    name: '30 - Request OTP for incorrect-code lockout',
    path: '/auth/otp/request',
    requestBody: { phone: '{{lockoutPhone}}', actorType: 'customer' },
    expectedStatus: 201,
    description: 'Creates the provider reference used to prove incorrect-code lockout.',
    tests: [
      'const ref = pm.response.json().data.providerRef;',
      "pm.test('Lockout reference exists', function () { pm.expect(ref).to.be.a('string').and.not.empty; });",
      "pm.environment.set('lockoutProviderRef', ref);",
    ],
    example: envelope({ providerRef: '<redacted provider reference>' }, 201),
  }),
);

for (let attempt = 1; attempt <= 6; attempt += 1) {
  authItems.push(
    requestItem({
      name: `31.${attempt} - Incorrect OTP lockout attempt ${attempt}`,
      path: '/auth/otp/verify',
      requestBody: {
        phone: '{{lockoutPhone}}',
        code: '000000',
        providerRef: '{{lockoutProviderRef}}',
        actorType: 'customer',
      },
      expectedStatus: attempt <= 5 ? 401 : 429,
      description:
        attempt <= 5
          ? `Incorrect verification attempt ${attempt} of 5. No tokens may be returned.`
          : 'Sixth verification is blocked before provider verification. Expected: HTTP 429.',
      tests: [
        attempt <= 5
          ? "pm.test('Incorrect code returns no tokens', function () { pm.expect(JSON.stringify(pm.response.json())).not.to.include('accessToken'); });"
          : "pm.test('Verification lockout is explicit', function () { pm.expect(pm.response.json().message).to.include('Too many incorrect codes'); });",
      ],
      example:
        attempt <= 5
          ? envelope(null, 401, 'Invalid or expired code')
          : envelope(
              null,
              429,
              'Too many incorrect codes - request a new OTP later',
            ),
    }),
  );
}

const liveItems = [
  requestItem({
    name: 'LIVE 01 - Request real customer OTP',
    path: '/auth/otp/request',
    requestBody: { phone: '{{livePhone}}', actorType: 'customer' },
    expectedStatus: 201,
    description:
      'Manual live-provider smoke request. Set livePhone as a Postman current value. Never commit the phone or returned provider reference.',
    prerequest: [
      "if (!pm.environment.get('runLiveProviderSmoke')) pm.execution.skipRequest();",
      "if (!pm.environment.get('livePhone')) throw new Error('Set livePhone as a private current value');",
    ],
    tests: [
      'const ref = pm.response.json().data.providerRef;',
      "pm.test('Real provider returned a reference', function () { pm.expect(ref).to.be.a('string').and.not.empty; });",
      "pm.environment.set('liveProviderRef', ref);",
    ],
    example: envelope({ providerRef: '<redacted real provider reference>' }, 201),
  }),
  requestItem({
    name: 'LIVE 02 - Verify user-entered real customer OTP',
    path: '/auth/otp/verify',
    requestBody: {
      phone: '{{livePhone}}',
      code: '{{liveOtpCode}}',
      providerRef: '{{liveProviderRef}}',
      actorType: 'customer',
    },
    expectedStatus: 201,
    description:
      'Run only after the user types the received OTP into liveOtpCode as a private current value. Tokens are kept only in the local environment.',
    prerequest: [
      "if (!pm.environment.get('runLiveProviderSmoke')) pm.execution.skipRequest();",
      "if (!/^\\d{6}$/.test(pm.environment.get('liveOtpCode') || '')) throw new Error('Set the received six-digit liveOtpCode');",
    ],
    tests: asciiScripts([
      ...tokenTests('Live customer'),
      'const data = pm.response.json().data;',
      "pm.environment.set('liveCustomerAccessToken', data.accessToken);",
      "pm.environment.set('liveCustomerRefreshToken', data.refreshToken);",
    ]),
    example: envelope(tokenExample, 201),
  }),
  requestItem({
    name: 'LIVE 03 - Validate real registered customer profile',
    method: 'GET',
    path: '/customers/me',
    authVariable: 'liveCustomerAccessToken',
    expectedStatus: 200,
    description:
      'Reads the customer created by real Slide OTP verification from PostgreSQL. Required identity fields must be populated; profile fields remain nullable until the customer updates them.',
    prerequest: [
      "if (!pm.environment.get('runLiveProviderSmoke')) pm.execution.skipRequest();",
      "if (!pm.environment.get('liveCustomerAccessToken')) throw new Error('Run LIVE 02 first');",
    ],
    tests: [
      'var responseData = pm.response.json().data;',
      "pm.test('Real customer identity is persisted and verified', function () {",
      "  pm.expect(responseData.id).to.be.a('string').and.match(/^[0-9a-f-]{36}$/i);",
      "  pm.expect(responseData.status).to.eql('verified');",
      "  pm.expect(responseData.phone).to.eql('+91' + pm.environment.get('livePhone'));",
      '  pm.expect(Number.isNaN(Date.parse(responseData.createdAt))).to.eql(false);',
      '  pm.expect(Number.isNaN(Date.parse(responseData.updatedAt))).to.eql(false);',
      '});',
      "pm.test('Uncollected profile fields are explicitly nullable', function () {",
      "  ['fullName', 'email', 'defaultAddressId'].forEach((key) => pm.expect(responseData).to.have.property(key));",
      '});',
      "pm.environment.set('liveCustomerId', responseData.id);",
    ],
    example: envelope({
      id: '<persisted customer UUID>',
      phone: '+91XXXXXXXXXX',
      fullName: null,
      email: null,
      status: 'verified',
      defaultAddressId: null,
      createdAt: '<ISO-8601 timestamp>',
      updatedAt: '<ISO-8601 timestamp>',
    }),
  }),
  requestItem({
    name: 'LIVE 04 - Exchange real Firebase admin ID token',
    path: '/auth/admin/firebase-login',
    requestBody: { idToken: '{{firebaseIdToken}}' },
    expectedStatus: 201,
    description:
      'Manual Firebase smoke. Requires a Firebase ID token whose UID is linked to an active AdminUser. Store it only as a Postman current value.',
    prerequest: [
      "if (!pm.environment.get('runFirebaseSmoke')) pm.execution.skipRequest();",
      "if (!pm.environment.get('firebaseIdToken')) throw new Error('Set firebaseIdToken as a private current value');",
    ],
    tests: asciiScripts([
      ...tokenTests('Firebase admin'),
      'const data = pm.response.json().data;',
      "pm.environment.set('adminAccessToken', data.accessToken);",
      "pm.environment.set('adminRefreshToken', data.refreshToken);",
    ]),
    example: envelope(tokenExample, 201),
  }),
];

const adminItems = [
  requestItem({
    name: '01 - Current admin context', method: 'GET', path: '/admin/me', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Returns the backend-authoritative role, permissions and city scope used to build admin navigation.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Role and permissions are populated', function () { pm.expect(responseData.role.name).to.be.a('string').and.not.empty; pm.expect(responseData.role.permissions).to.be.an('array').and.not.empty; pm.expect(responseData.cityScope).to.be.an('array'); });"],
    example: envelope({ id: '<admin UUID>', fullName: 'Operations Admin', cityScope: ['<city UUID>'], role: { id: '<role UUID>', name: 'ops', permissions: ['admin.dashboard.read'] } }),
  }),
  requestItem({
    name: '02 - Live dispatch polling snapshot', method: 'GET', path: '/admin/dispatch/live-map?cityId={{cityId}}', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'HTTP polling source for the dispatch map. WebSockets are deliberately deferred.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Snapshot is complete', function () { pm.expect(responseData.cityId).to.eql(pm.environment.get('cityId')); pm.expect(responseData.bookings).to.be.an('array'); pm.expect(responseData.pros).to.be.an('array'); pm.expect(Number.isNaN(Date.parse(responseData.serverTime))).to.eql(false); });"],
    example: envelope({ serverTime: '<ISO-8601>', cityId: '<city UUID>', bookings: [], pros: [] }),
  }),
  requestItem({
    name: '03 - Pro 360', method: 'GET', path: '/admin/pros/{{proId}}/360', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Aggregated Pro support view. Acceptance rate always includes raw offered and acknowledged counts.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Standing has raw evidence', function () { pm.expect(responseData.acceptance).to.include.all.keys('offered', 'acknowledged', 'rate', 'reportingOnly'); pm.expect(responseData.rating).to.include.all.keys('sum', 'count', 'average'); pm.expect(responseData.services).to.be.an('array'); pm.expect(responseData.trainingProgress).to.be.an('array'); });"],
    example: envelope({ id: '<pro UUID>', acceptance: { offered: 40, acknowledged: 37, rate: 0.925, reportingOnly: true }, rating: { sum: 92, count: 20, average: 4.6 }, services: [], trainingProgress: [], commissions: [], payouts: [] }),
  }),
  requestItem({
    name: '04 - Customer 360', method: 'GET', path: '/admin/customers/{{customerId}}/360', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Aggregates existing customer, address, booking, order, refund and review data. Missing Modules 11/12 are explicitly marked unavailable.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Customer collections are real arrays', function () { pm.expect(responseData.addresses).to.be.an('array'); pm.expect(responseData.bookings).to.be.an('array'); pm.expect(responseData.orders).to.be.an('array'); pm.expect(responseData.reviews).to.be.an('array'); pm.expect(responseData.support.available).to.eql(false); });"],
    example: envelope({ id: '<customer UUID>', addresses: [], bookings: [], orders: [], reviews: [], support: { available: false }, notifications: { available: false } }),
  }),
  requestItem({
    name: '05 - Effective platform settings', method: 'GET', path: '/admin/platform-settings?cityId={{cityId}}', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Shows global, city override and effective source separately.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Settings declare their source', function () { pm.expect(responseData).to.be.an('array').and.not.empty; responseData.forEach(function (row) { pm.expect(row).to.include.all.keys('key', 'global', 'cityOverride', 'effectiveValue', 'source'); }); });"],
    example: envelope([{ key: 'assignment.ackWindowSeconds', global: { value: '30' }, cityOverride: null, effectiveValue: '30', source: 'global' }]),
  }),
  requestItem({
    name: '06 - Queue async availability bulk job', path: '/admin/bulk-jobs', authVariable: 'adminAccessToken', expectedStatus: 202,
    requestBody: { targetEntity: 'pros', proIds: ['{{proId}}'], isAvailable: true },
    description: 'Queues a safe idempotent availability update; inspect the job instead of assuming it completed inline.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Job is durable and queued', function () { pm.expect(responseData.id).to.match(/^[0-9a-f-]{36}$/i); pm.expect(responseData.jobType).to.eql('bulk_update'); pm.expect(responseData.status).to.eql('queued'); });", "pm.environment.set('adminJobId', responseData.id);"],
    example: envelope({ id: '<job UUID>', jobType: 'bulk_update', targetEntity: 'pros', status: 'queued', totalCount: 1 }, 202, 'Accepted'),
  }),
  requestItem({
    name: '07 - Read async job progress', method: 'GET', path: '/admin/jobs/{{adminJobId}}', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Returns durable progress and completed/partial/failed outcome.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Progress counters are never null', function () { ['totalCount','processedCount','succeededCount','failedCount'].forEach(function (key) { pm.expect(responseData[key]).to.be.a('number'); }); });"],
    example: envelope({ id: '<job UUID>', status: 'completed', totalCount: 1, processedCount: 1, succeededCount: 1, failedCount: 0, resultFileKey: null }),
  }),
  requestItem({
    name: '08 - Queue operational CSV export', path: '/admin/reports/exports', authVariable: 'adminAccessToken', expectedStatus: 202,
    requestBody: { type: 'operational', format: 'csv', cityIds: ['{{cityId}}'], from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    description: 'Queues a city-scoped export. Use xlsx or pdf in format to validate the other renderers.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Report job is queued', function () { pm.expect(responseData.jobType).to.eql('report_export'); pm.expect(responseData.format).to.eql('csv'); });", "pm.environment.set('reportJobId', responseData.id);"],
    example: envelope({ id: '<job UUID>', jobType: 'report_export', targetEntity: 'operational', format: 'csv', status: 'queued' }, 202, 'Accepted'),
  }),
  requestItem({
    name: '09 - Marketing overview', method: 'GET', path: '/admin/analytics/overview?cityIds={{cityId}}', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Separates GMV from net platform revenue and includes cash bookings.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Money is explicit and populated', function () { pm.expect(responseData.money.currency).to.eql('INR'); pm.expect(responseData.money.gmv).to.match(/^\\d+\\.\\d{2}$/); pm.expect(responseData.money.netPlatformRevenue).to.match(/^\\d+\\.\\d{2}$/); });"],
    example: envelope({ bookings: { requested: 10, completed: 8, cancelled: 1, completionRate: 0.8 }, money: { currency: 'INR', gmv: '4792.00', netPlatformRevenue: '1437.60' }, dispatch: { noSupply: 0, exhausted: 1, averageAssignmentSeconds: 48 } }),
  }),
  requestItem({
    name: '10 - Retention cohorts', method: 'GET', path: '/admin/analytics/retention?cityIds={{cityId}}', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: '30/60/90-day repeat booking cohort metrics.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Retention rates are bounded', function () { ['days30','days60','days90'].forEach(function (key) { pm.expect(responseData.rates[key]).to.be.within(0, 1); }); });"],
    example: envelope({ customers: 20, days30: 8, days60: 11, days90: 13, rates: { days30: 0.4, days60: 0.55, days90: 0.65 } }),
  }),
  requestItem({
    name: '11 - Reassign booking through dispatch', path: '/admin/bookings/{{bookingId}}/reassign', authVariable: 'adminAccessToken', expectedStatus: 200,
    requestBody: { mode: 'redispatch', reason: 'Original professional became unavailable during travel' },
    description: 'Mutating operation: returns an assigned or en-route booking to the existing dispatch engine. Allowed only before arrival; the reason is mandatory.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Booking is durably returned to dispatch', function () { pm.expect(responseData.id).to.eql(pm.environment.get('bookingId')); pm.expect(responseData.status).to.eql('assigning'); pm.expect(responseData.proId).to.eql(null); pm.expect(responseData.overrideReason).to.be.a('string').and.not.empty; });"],
    example: envelope({ id: '<booking UUID>', bookingNumber: 'HB-2026-000123', status: 'assigning', proId: null, overriddenByAdminId: '<admin UUID>', overrideReason: 'Original professional became unavailable during travel' }),
  }),
  requestItem({
    name: '12 - Set a city platform-setting override', method: 'PUT', path: '/admin/platform-settings/reporting.customerActiveDays', authVariable: 'adminAccessToken', expectedStatus: 200,
    requestBody: { value: '30', cityId: '{{cityId}}' },
    description: 'Creates or replaces a validated city override. Scoped admins cannot change global values.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Override is stored with its owner', function () { pm.expect(responseData.key).to.eql('reporting.customerActiveDays'); pm.expect(responseData.cityId).to.eql(pm.environment.get('cityId')); pm.expect(responseData.value).to.eql('30'); pm.expect(responseData.updatedByAdminId).to.be.a('string').and.not.empty; });"],
    example: envelope({ id: '<setting UUID>', key: 'reporting.customerActiveDays', cityId: '<city UUID>', value: '30', description: 'Active customer lifecycle window.', updatedByAdminId: '<admin UUID>' }),
  }),
  requestItem({
    name: '13 - Reset a city platform-setting override', method: 'DELETE', path: '/admin/platform-settings/reporting.customerActiveDays?cityId={{cityId}}', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Removes only the city override so the global value becomes effective again.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Only the requested override was reset', function () { pm.expect(responseData).to.eql({ key: 'reporting.customerActiveDays', cityId: pm.environment.get('cityId'), reset: true }); });"],
    example: envelope({ key: 'reporting.customerActiveDays', cityId: '<city UUID>', reset: true }),
  }),
  requestItem({
    name: '14 - List async admin jobs', method: 'GET', path: '/admin/jobs?take=25', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Non-super-admins see only their own jobs; super admins may inspect all requesters.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Job list has concrete states and counters', function () { pm.expect(responseData).to.be.an('array'); responseData.forEach(function (job) { pm.expect(['queued','running','completed','partial','failed']).to.include(job.status); ['totalCount','processedCount','succeededCount','failedCount'].forEach(function (key) { pm.expect(job[key]).to.be.a('number'); }); }); });"],
    example: envelope([{ id: '<job UUID>', jobType: 'bulk_update', targetEntity: 'pros', status: 'completed', totalCount: 1, processedCount: 1, succeededCount: 1, failedCount: 0 }]),
  }),
  requestItem({
    name: '15 - Queue async Pro-service activation', path: '/admin/bulk-jobs', authVariable: 'adminAccessToken', expectedStatus: 202,
    requestBody: { targetEntity: 'pro_services', proIds: ['{{proId}}'], serviceId: '{{serviceId}}', isActive: true },
    description: 'The second supported bulk mutation. The worker reuses Pro service-assignment validation and records per-row failures.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Pro-service bulk job is queued', function () { pm.expect(responseData.jobType).to.eql('bulk_update'); pm.expect(responseData.targetEntity).to.eql('pro_services'); pm.expect(responseData.totalCount).to.eql(1); });", "pm.environment.set('adminJobId', responseData.id);"],
    example: envelope({ id: '<job UUID>', jobType: 'bulk_update', targetEntity: 'pro_services', status: 'queued', totalCount: 1 }, 202, 'Accepted'),
  }),
  requestItem({
    name: '16 - Queue commission XLSX export', path: '/admin/reports/exports', authVariable: 'adminAccessToken', expectedStatus: 202,
    requestBody: { type: 'commission', format: 'xlsx', cityIds: ['{{cityId}}'], proIds: ['{{proId}}'], serviceIds: ['{{serviceId}}'], from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    description: 'Uses snapshotted BookingCommission values and exercises XLSX rendering.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Commission XLSX export is queued', function () { pm.expect(responseData.targetEntity).to.eql('commission'); pm.expect(responseData.format).to.eql('xlsx'); });", "pm.environment.set('reportJobId', responseData.id);"],
    example: envelope({ id: '<job UUID>', jobType: 'report_export', targetEntity: 'commission', format: 'xlsx', status: 'queued' }, 202, 'Accepted'),
  }),
  requestItem({
    name: '17 - Queue retention PDF export', path: '/admin/reports/exports', authVariable: 'adminAccessToken', expectedStatus: 202,
    requestBody: { type: 'retention', format: 'pdf', cityIds: ['{{cityId}}'], customerSegments: ['active', 'repeat'], from: '2026-01-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
    description: 'Exercises cohort filters and PDF rendering. The submitting admin also needs customer.read.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Retention PDF export is queued', function () { pm.expect(responseData.targetEntity).to.eql('retention'); pm.expect(responseData.format).to.eql('pdf'); });", "pm.environment.set('reportJobId', responseData.id);"],
    example: envelope({ id: '<job UUID>', jobType: 'report_export', targetEntity: 'retention', format: 'pdf', status: 'queued' }, 202, 'Accepted'),
  }),
  requestItem({
    name: '18 - Queue city-performance CSV export', path: '/admin/reports/exports', authVariable: 'adminAccessToken', expectedStatus: 202,
    requestBody: { type: 'city_performance', format: 'csv', cityIds: ['{{cityId}}'], from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    description: 'Completes report-type coverage and leaves reportJobId pointing to this job for progress/download checks.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('City-performance export is queued', function () { pm.expect(responseData.targetEntity).to.eql('city_performance'); pm.expect(responseData.format).to.eql('csv'); });", "pm.environment.set('reportJobId', responseData.id);"],
    example: envelope({ id: '<job UUID>', jobType: 'report_export', targetEntity: 'city_performance', format: 'csv', status: 'queued' }, 202, 'Accepted'),
  }),
  requestItem({
    name: '19 - Read report job progress', method: 'GET', path: '/admin/jobs/{{reportJobId}}', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Repeat until status is completed before using the download request.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Report progress is explicit', function () { pm.expect(responseData.jobType).to.eql('report_export'); pm.expect(['queued','running','completed','failed']).to.include(responseData.status); pm.expect(responseData.failureReason === null || typeof responseData.failureReason === 'string').to.eql(true); });"],
    example: envelope({ id: '<job UUID>', jobType: 'report_export', targetEntity: 'city_performance', format: 'csv', status: 'completed', totalCount: 1, processedCount: 1, succeededCount: 1, failedCount: 0, resultFileKey: '<private S3 key>', failureReason: null }),
  }),
  requestItem({
    name: '20 - Get temporary report download URL', method: 'GET', path: '/admin/jobs/{{reportJobId}}/download', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Run after request 19 reports completed. Returns a 15-minute private S3 URL, never a public object URL.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Download is temporary and named', function () { pm.expect(responseData.viewUrl).to.match(/^https?:\/\//); pm.expect(responseData.expiresIn).to.eql(900); pm.expect(responseData.fileName).to.be.a('string').and.match(/\.(csv|xlsx|pdf)$/); });"],
    example: envelope({ viewUrl: 'https://<private-s3-signed-url>', expiresIn: 900, fileName: 'city_performance-<job UUID>.csv' }),
  }),
  requestItem({
    name: '21 - City performance analytics', method: 'GET', path: '/admin/analytics/cities?cityIds={{cityId}}', authVariable: 'adminAccessToken', expectedStatus: 200,
    description: 'Returns city-level bookings, completion, supply outcomes, GMV and net platform revenue.',
    tests: ['var responseData = pm.response.json().data;', "pm.test('Every city row has marketing and operational metrics', function () { pm.expect(responseData).to.be.an('array'); responseData.forEach(function (row) { pm.expect(row).to.include.all.keys('cityId','cityName','bookings','completed','cancelled','noSupply','gmv','netPlatformRevenue'); pm.expect(row.gmv).to.match(/^\d+\.\d{2}$/); pm.expect(row.netPlatformRevenue).to.match(/^-?\d+\.\d{2}$/); }); });"],
    example: envelope([{ cityId: '<city UUID>', cityName: 'Indore', bookings: 120, completed: 96, cancelled: 12, noSupply: 3, gmv: '57504.00', netPlatformRevenue: '17251.20' }]),
  }),
];

const modules = [
  ['00 - Health & Contract', 'Server readiness and cross-module contract checks.', []],
  [
    '01 - Identity, Authentication & Registration',
    'Complete Module 1 verification. Run in numeric order.',
    authItems,
  ],
  ['02 - Customer Profile & Addresses', 'Reserved for the next implementation pass.', []],
  ['03 - Service Catalog', 'Reserved for the service-catalog pass.', []],
  ['04 - Booking Lifecycle', 'Reserved for booking and recurring-plan scenarios.', []],
  ['05 - Dispatch Engine', 'Reserved for assignment and acknowledgement scenarios.', []],
  ['06 - Pro Management', 'Reserved for onboarding, KYC, bank, availability, and location.', []],
  ['07 - Payments', 'Reserved for online payment, refunds, and cash collection.', []],
  ['08 - Commission, Incentives & Payouts', 'Reserved for Module 8.', []],
  ['09 - Ledger & Reconciliation', 'Reserved for Module 9.', []],
  ['10 - Training & Reviews', 'Reserved for Module 10.', []],
  ['11 - Safety & Support', 'Not implemented by the backend yet; intentionally contains no fake API requests.', []],
  ['12 - Notifications', 'Not implemented by the backend yet; intentionally contains no fake API requests.', []],
  ['13 - Service Areas & Geo', 'Reserved; the existing verified geo collection will be merged here.', []],
  ['14 - Runtime Configuration', 'No API is implemented yet; intentionally contains no fake requests.', []],
  ['15 - Admin Console & Reporting', 'Backend Module 15 requests with bodies, expected responses and value assertions. Audit and admin WebSockets are deliberately deferred.', adminItems],
  ['90 - Gateway Webhooks', 'Reserved for signed Razorpay and RazorpayX callbacks.', []],
  ['99 - Live Provider Smoke (Manual)', 'Skipped in automated runs. Private values must never be committed.', liveItems],
];

const collection = {
  info: {
    _postman_id: '7e77ab4b-a87d-49ed-b2a0-ae8b00579f41',
    name: 'Homingo - Complete API Deployment Gate',
    description:
      'Canonical Homingo Postman workspace. Requests retain bodies, expected sanitized responses, and executable tests. Module folders are populated and verified incrementally; empty folders are explicit future work, not evidence of coverage.',
    schema:
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: modules.map(([name, description, items]) => ({
    name,
    description,
    item: items,
  })),
  variable: [{ key: 'expectedStatus', value: '200', type: 'string' }],
};

const environment = {
  id: 'f2674361-e141-4ed2-82df-769ab5c96d13',
  name: 'Homingo - Local Isolated',
  values: [
    ['baseUrl', 'http://127.0.0.1:53014/api/v1', true],
    ['guestDeviceId', 'auth-postman-device-0001', true],
    ['customerPhone', '7828241001', true],
    ['proPhone', '7828241002', true],
    ['sessionPhone', '7828241003', true],
    ['rateLimitPhone', '7828241004', true],
    ['lockoutPhone', '7828241005', true],
    ['mockOtpCode', '123456', true],
    ['runLiveProviderSmoke', '', true],
    ['livePhone', '', true],
    ['liveOtpCode', '', true],
    ['runFirebaseSmoke', '', true],
    ['firebaseIdToken', '', true],
    ['cityId', '', true],
    ['serviceId', '', true],
    ['proId', '', true],
    ['customerId', '', true],
    ['bookingId', '', true],
    ['adminJobId', '', true],
    ['reportJobId', '', true],
  ].map(([key, value, enabled]) => ({ key, value, enabled, type: 'default' })),
  _postman_variable_scope: 'environment',
  _postman_exported_at: new Date().toISOString(),
  _postman_exported_using: 'Homingo collection generator',
};

await mkdir(dirname(collectionPath), { recursive: true });
await writeFile(collectionPath, `${JSON.stringify(collection, null, 2)}\n`);
await writeFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`);
console.log(`Generated ${collectionPath}`);
console.log(`Generated ${environmentPath}`);
console.log(`Authentication requests: ${authItems.length}`);

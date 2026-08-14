# Homingo Authentication and Registration Postman evidence

Generated: 2026-08-13T10:11:40.659Z

These are sanitized responses captured from real HTTP calls to the isolated Homingo application. Full request and response bodies are in the adjacent JSON evidence file.

- Requests executed: 41
- Assertions: 161
- Failed assertions: 0

|   # | Method | Request                                                | Status | Time (ms) | Tests |
| --: | :----: | ------------------------------------------------------ | -----: | --------: | ----: |
|   1 |  GET   | 01 - Health readiness before authentication            |    200 |        72 |  Pass |
|   2 |  POST  | 02 - Reject short guest device identifier              |    400 |        51 |  Pass |
|   3 |  POST  | 03 - Create guest registration session                 |    201 |       396 |  Pass |
|   4 |  GET   | 04 - Read guest profile and save registration identity |    200 |        17 |  Pass |
|   5 |  POST  | 05 - Resume the same guest session                     |    201 |        20 |  Pass |
|   6 |  POST  | 06 - Reject malformed OTP phone                        |    400 |        31 |  Pass |
|   7 |  POST  | 07 - Reject admin OTP authentication                   |    400 |        29 |  Pass |
|   8 |  POST  | 08 - Request customer registration OTP                 |    201 |        21 |  Pass |
|   9 |  POST  | 09 - Reject incorrect customer OTP                     |    401 |        23 |  Pass |
|  10 |  POST  | 10 - Verify OTP and register customer                  |    201 |        95 |  Pass |
|  11 |  GET   | 11 - Validate persisted verified customer registration |    200 |        31 |  Pass |
|  12 |  POST  | 12 - Request OTP for existing-customer login           |    201 |        32 |  Pass |
|  13 |  POST  | 13 - Login existing customer with OTP                  |    201 |        48 |  Pass |
|  14 |  GET   | 14 - Confirm existing login resolves the same customer |    200 |        43 |  Pass |
|  15 |  POST  | 15 - Request Pro registration OTP                      |    201 |        21 |  Pass |
|  16 |  POST  | 16 - Verify OTP and register Pro                       |    201 |       127 |  Pass |
|  17 |  GET   | 17 - Validate persisted Pro registration               |    200 |        28 |  Pass |
|  18 |  POST  | 18 - Rotate customer refresh token                     |    201 |        25 |  Pass |
|  19 |  POST  | 19 - Reject replay of rotated refresh token            |    401 |        23 |  Pass |
|  20 |  POST  | 20 - Confirm replay revoked the rotated session        |    401 |        22 |  Pass |
|  21 |  POST  | 21 - Logout Pro single session                         |    204 |         8 |  Pass |
|  22 |  POST  | 22 - Reject refresh after single-session logout        |    401 |        10 |  Pass |
|  23 |  POST  | 23 - Request OTP for logout-all session                |    201 |        12 |  Pass |
|  24 |  POST  | 24 - Verify logout-all customer session                |    201 |        46 |  Pass |
|  25 |  POST  | 25 - Revoke every current customer session             |    204 |        10 |  Pass |
|  26 |  POST  | 26 - Reject refresh after logout-all                   |    401 |         7 |  Pass |
|  27 |  POST  | 27 - Reject logout-all without bearer token            |    401 |        11 |  Pass |
|  28 |  POST  | 28 - Reject invalid Firebase admin identity token      |    401 |         9 |  Pass |
|  29 |  POST  | 29.1 - OTP request rate limit attempt 1                |    201 |        14 |  Pass |
|  30 |  POST  | 29.2 - OTP request rate limit attempt 2                |    201 |         8 |  Pass |
|  31 |  POST  | 29.3 - OTP request rate limit attempt 3                |    201 |         8 |  Pass |
|  32 |  POST  | 29.4 - OTP request rate limit attempt 4                |    201 |         7 |  Pass |
|  33 |  POST  | 29.5 - OTP request rate limit attempt 5                |    201 |         8 |  Pass |
|  34 |  POST  | 29.6 - OTP request rate limit attempt 6                |    429 |         7 |  Pass |
|  35 |  POST  | 30 - Request OTP for incorrect-code lockout            |    201 |         7 |  Pass |
|  36 |  POST  | 31.1 - Incorrect OTP lockout attempt 1                 |    401 |        10 |  Pass |
|  37 |  POST  | 31.2 - Incorrect OTP lockout attempt 2                 |    401 |        13 |  Pass |
|  38 |  POST  | 31.3 - Incorrect OTP lockout attempt 3                 |    401 |         9 |  Pass |
|  39 |  POST  | 31.4 - Incorrect OTP lockout attempt 4                 |    401 |        10 |  Pass |
|  40 |  POST  | 31.5 - Incorrect OTP lockout attempt 5                 |    401 |         6 |  Pass |
|  41 |  POST  | 31.6 - Incorrect OTP lockout attempt 6                 |    429 |        14 |  Pass |

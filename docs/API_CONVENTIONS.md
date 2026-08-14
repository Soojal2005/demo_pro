+# API Conventions

**Binding on every module.** These rules exist so two developers working in
parallel produce one API rather than two, and so the frontend can generate a
client instead of reading our code.

Modules and their boundaries are defined in [`Modules_and_Features 1.md`](Modules_and_Features%201.md).
This document covers only the shape of what crosses the wire.

---

## 1 · One envelope, always

Every response — success or failure, every endpoint, no exceptions — is:

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Success",
  "data": {},
  "timestamp": "2026-08-07T09:15:00.000Z",
  "path": "/api/v1/bookings"
}
```

On a failure `data` is `errors` carries the detail:

```json
{
  "success": false,
  "statusCode": 400,
  "message": "Validation failed",
  "data": null,
  "errors": [{ "field": "email", "message": "email must be an email" }],
  "timestamp": "2026-08-07T09:15:00.000Z",
  "path": "/api/v1/customers"
}
```

The single source of truth is [`src/common/utils.ts`](../src/common/utils.ts).
**Do not define a response type in your module.** If you need a field the
envelope doesn't have, change `utils.ts` — as its own small PR, announced —
rather than working around it locally.

### How it is applied

You don't build the envelope by hand. Two global pieces do it:

| Piece                                                                       | Handles                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`ResponseInterceptor`](../src/common/interceptors/response.interceptor.ts) | Wraps whatever a handler returns                                    |
| [`AllExceptionsFilter`](../src/common/filters/all-exceptions.filter.ts)     | Wraps every thrown error, including validation failures and crashes |

So a controller returns **the bare payload**:

```ts
@Get(':id')
findOne(@Param('id') id: string): Promise<BookingDto> {
  return this.bookings.findOne(id);   // interceptor wraps it
}
```

### When you need a custom message

Call `successResponse()` yourself. The interceptor detects an envelope and
passes it through rather than wrapping it twice:

```ts
import { successResponse } from '../../common/utils';

@Post()
async create(@Body() dto: CreateBookingDto) {
  const booking = await this.bookings.create(dto);
  return successResponse({
    data: booking,
    message: 'Booking created',
    statusCode: HttpStatus.CREATED,
  });
}
```

### Failing a request

Throw `apiError()`. Never return an error shape, and never throw a bare
`HttpException` — `apiError` is what puts your message and field detail into
the envelope.

```ts
import { apiError } from '../../common/utils';

if (!booking) {
  throw apiError('Booking not found', HttpStatus.NOT_FOUND);
}

// With field-level detail:
throw apiError('Cannot cancel a started job', HttpStatus.CONFLICT, [
  { field: 'status', message: 'Job is already started', code: 'JOB_STARTED' },
]);
```

**Never put internal detail in the message** — it goes straight to the client.
An unexpected `throw new Error(...)` is caught by the filter, reported as a
generic `Internal server error`, and the real cause is logged server-side.
That is deliberate; don't defeat it by catching and rethrowing as `apiError`
with the raw text.

---

## 2 · Swagger is the frontend's contract

Docs are generated, not written. They're mounted at:

| Url          | What                                               |
| ------------ | -------------------------------------------------- |
| `/docs`      | Interactive UI                                     |
| `/docs/json` | **OpenAPI spec — point the client generator here** |
| `/docs/yaml` | Same, YAML                                         |

On outside production, off inside it. Override with `SWAGGER_ENABLED`.

### The rule that matters

Swagger reads a handler's **declared return type**, which is the bare payload.
The interceptor adds the envelope _afterwards_, and Swagger never sees it. So
documenting an endpoint with Swagger's own `@ApiOkResponse({ type: Dto })`
publishes a schema **the API never sends**.

Use the envelope decorators from
[`src/common/swagger/api-envelope.decorator.ts`](../src/common/swagger/api-envelope.decorator.ts)
instead. They nest your payload under `data` inside the shared envelope:

```ts
import {
  ApiOkEnvelope,
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
} from '../../common/swagger/api-envelope.decorator';

@ApiTags('Bookings')                       // one tag per module
@Controller('bookings')
export class BookingController {
  /** Fetch a single booking by id. */     // JSDoc becomes the description
  @Get(':id')
  @ApiOperation({ summary: 'Get a booking' })
  @ApiOkEnvelope(BookingDto)
  @ApiErrorEnvelope(HttpStatus.NOT_FOUND)
  findOne(@Param('id') id: string): Promise<BookingDto> { ... }

  @Get()
  @ApiOkEnvelope(BookingDto, { isArray: true })
  findAll(): Promise<BookingDto[]> { ... }

  @Post()
  @ApiCreatedEnvelope(BookingDto)
  @ApiErrorEnvelope(HttpStatus.BAD_REQUEST, HttpStatus.CONFLICT)
  create(@Body() dto: CreateBookingDto): Promise<BookingDto> { ... }

  @Delete(':id')
  @ApiOkEnvelope()                          // no payload — data is null
  remove(@Param('id') id: string): Promise<void> { ... }
}
```

`@ApiErrorEnvelope()` takes only statuses — never a type. Every failure in
this API has the same shape. List the statuses the endpoint can **actually**
return; a frontend that has to guess will handle the wrong ones.

### Decorator order — the trap

Decorators apply **bottom-up**. Any library decorator that also declares
Swagger responses will overwrite yours if it sits above them. Terminus's
`@HealthCheck()` does exactly this — see
[`health.controller.ts`](../src/health/health.controller.ts) for the working
order. Put library decorators **below** the envelope decorators.

There is a regression test for this in
[`test/swagger-envelope.e2e-spec.ts`](../test/swagger-envelope.e2e-spec.ts).
It asserts the generated spec really is the envelope and that the documented
fields match what `utils.ts` sends at runtime. If you change either side and
the other doesn't follow, that suite fails.

### DTOs

- Name files `*.dto.ts` and put them in `<module>/dto/`. The `@nestjs/swagger`
  CLI plugin (configured in [`nest-cli.json`](../nest-cli.json)) only picks up
  that suffix.
- With the plugin on, **you rarely need `@ApiProperty`** — types, optionality
  and `class-validator` decorators are read automatically, and a JSDoc comment
  becomes the field description. Add `@ApiProperty` only for an example or a
  constraint the plugin can't infer.
- The plugin runs under `nest build` / `nest start`, **not** under ts-jest. A
  DTO declared inside a test file needs explicit `@ApiProperty`.

---

## 3 · Validation

Configured once in [`validation.config.ts`](../src/config/validation.config.ts)
and shared with the e2e tests, so a test proves the real configuration.

Unknown properties are **rejected**, not stripped — a typo'd field fails loudly
instead of looking like it saved. Every input DTO needs `class-validator`
decorators; without them `whitelist: true` strips the whole body and the
handler receives `{}`.

---

## 4 · Git hooks

Installed automatically — `npm install` runs `prepare`, which sets up husky.
Nobody has to remember a setup step, and neither of us can push work that
breaks the other's branch.

| Hook         | Runs                                                                                           | Why                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pre-commit` | `lint-staged` — `eslint --fix` on staged `.ts`, `prettier --write` on staged `json`/`md`/`yml` | Fast, staged files only. Also means we both format identically, so no PR is half formatting noise |
| `pre-push`   | `npm run typecheck && npm run test:e2e`                                                        | The real gate. A commit can type-check in isolation and still break something elsewhere           |

`eslint` runs with `--max-warnings=0`, so a warning blocks the commit. Fix it,
or change the rule in [`eslint.config.mjs`](../eslint.config.mjs) as a
deliberate, announced decision — don't leave warnings accumulating.

`package-lock.json` is in [`.prettierignore`](../.prettierignore). Never
reformat it: npm regenerates it, and a formatted lockfile conflicts with every
open branch at once.

`--no-verify` skips a hook. It exists for genuine emergencies; if you find
yourself reaching for it routinely, the hook is wrong and we should fix it.

---

## 5 · Checklist before you push

- [ ] Controller returns a bare payload, or `successResponse()` for a custom message
- [ ] Failures thrown with `apiError()`, never a bare `HttpException`
- [ ] No error text that leaks internal detail
- [ ] `@ApiTags` matches your module name
- [ ] Every endpoint has `@ApiOkEnvelope` / `@ApiCreatedEnvelope` **and** `@ApiErrorEnvelope`
- [ ] Library decorators sit below the envelope decorators
- [ ] Input DTOs carry `class-validator` decorators
- [ ] `npm run build && npm run test:e2e && npm run lint` all pass

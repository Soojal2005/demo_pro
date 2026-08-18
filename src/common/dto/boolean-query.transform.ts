import { Transform } from 'class-transformer';

/**
 * Reads a boolean out of a query string.
 *
 * `@Type(() => Boolean)` cannot do this. A query string arrives as text, and
 * `Boolean('false')` is `true` — every non-empty string is. So a filter
 * declared that way accepts `?isActive=false` without complaint and then
 * behaves as though `true` had been asked for: the caller gets the exact
 * opposite of what they requested, with no error to explain it.
 *
 * Both spellings a client is likely to send are accepted: `true`/`false` and
 * `1`/`0`. Anything else is passed through untouched so `@IsBoolean()` rejects
 * it with a real 400 rather than silently reading as `true`.
 */
export function parseBooleanQuery(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  return value;
}

/**
 * `?flag=false` → `false`, on an optional boolean query param.
 *
 * Reads `obj[key]`, not `value`, and that detail is the whole point. This app
 * runs with `enableImplicitConversion: true` (see `validation.config.ts`), so
 * class-transformer has already applied `Boolean(...)` to the reflected type
 * by the time a `@Transform` callback runs — `value` is a coerced `true` with
 * the original string gone. `obj` is the untouched plain query object, so it
 * still holds the text that was actually sent. The callback's return value
 * wins over the implicit conversion, which is what makes the repair stick.
 */
export function BooleanQuery(): PropertyDecorator {
  return Transform(({ obj, key }) =>
    parseBooleanQuery((obj as Record<string, unknown>)[key]),
  );
}

import 'reflect-metadata';
import { IsBoolean, IsOptional } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BooleanQuery, parseBooleanQuery } from './boolean-query.transform';
import { VALIDATION_PIPE_OPTIONS } from '../../config/validation.config';

describe('parseBooleanQuery', () => {
  /**
   * The whole reason this exists. `@Type(() => Boolean)` turned this into
   * `true`, so `?isActive=false` returned the active rows — the opposite of
   * what was asked, and silently.
   */
  it('reads "false" as false', () => {
    expect(parseBooleanQuery('false')).toBe(false);
    expect(parseBooleanQuery('FALSE')).toBe(false);
    expect(parseBooleanQuery(' false ')).toBe(false);
    expect(parseBooleanQuery('0')).toBe(false);
  });

  it('reads "true" as true', () => {
    expect(parseBooleanQuery('true')).toBe(true);
    expect(parseBooleanQuery('True')).toBe(true);
    expect(parseBooleanQuery('1')).toBe(true);
  });

  it('leaves an already-boolean value alone', () => {
    expect(parseBooleanQuery(true)).toBe(true);
    expect(parseBooleanQuery(false)).toBe(false);
  });

  /**
   * Passed through rather than guessed at, so `@IsBoolean()` answers with a
   * 400 naming the field. Coercing it here would put us back where we
   * started — an unreadable value quietly becoming `true`.
   */
  it('passes anything else through for the validator to reject', () => {
    expect(parseBooleanQuery('yes')).toBe('yes');
    expect(parseBooleanQuery('')).toBe('');
    expect(parseBooleanQuery(undefined)).toBeUndefined();
    expect(parseBooleanQuery(2)).toBe(2);
  });
});

class QueryFixture {
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Run through the app's real transform options rather than defaults. The trap
 * this guards only appears under `enableImplicitConversion`, so a test using
 * class-transformer's defaults would pass while the API stayed broken.
 */
describe('@BooleanQuery under the app’s own validation options', () => {
  const parse = (isActive: string) =>
    plainToInstance(
      QueryFixture,
      { isActive },
      VALIDATION_PIPE_OPTIONS.transformOptions,
    ).isActive;

  it('survives implicit conversion, which reaches the callback first', () => {
    expect(parse('false')).toBe(false);
    expect(parse('true')).toBe(true);
  });

  it('leaves an unreadable value for @IsBoolean() to reject', () => {
    expect(parse('maybe')).toBe('maybe');
  });
});

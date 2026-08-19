import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * A free-text field that exists to be a record, and so must actually hold one.
 *
 * `@IsString() @MaxLength(n)` alone lets `""` through. On the fields this
 * guards — why a commission was reversed, why a deduction was raised or
 * forgiven, why a payout was rejected, what answered a reconciliation
 * finding — an empty value means the money moved and nothing on the row says
 * who decided that or why. Several of them are read by the Pro whose money it
 * was.
 *
 * Trimmed before the check, so a single space is not a way around it.
 *
 * @param maxLength the field's own limit; these differ per field.
 * @param label what to call the field in the 400, e.g. `'reason'`.
 */
export function RequiredText(
  maxLength: number,
  label: string,
): PropertyDecorator {
  return (target, key) => {
    Transform(({ value }): unknown =>
      typeof value === 'string' ? value.trim() : value,
    )(target, key);
    IsString()(target, key);
    IsNotEmpty({ message: `${label} is required` })(target, key);
    MaxLength(maxLength)(target, key);
  };
}

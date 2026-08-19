/**
 * Normalises a free-text admin search term.
 *
 * Trims, and drops a leading `+` from what is otherwise all digits. Phone
 * numbers are stored in more than one shape across the platform — some rows
 * predate E.164 canonicalisation — so a `contains` match on `919818394735`
 * finds both `+919818394735` and `9818394735`, while the `+` form finds only
 * one of them. An admin pasting a number out of a support ticket should not
 * have to know which shape the row happens to be in.
 *
 * Anything that is not a bare number is passed through untouched, so a name
 * search behaves normally.
 */
export function normaliseSearchTerm(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return /^\+\d+$/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

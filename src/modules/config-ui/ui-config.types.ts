export const UI_SEGMENTS = [
  'all',
  'anonymous',
  'new',
  'active',
  'repeat',
  'at_risk',
  'lapsed',
  'never_booked',
] as const;

export type UiSegment = (typeof UI_SEGMENTS)[number];

export interface UiTree {
  schemaVersion: 1;
  components: Array<Record<string, unknown>>;
}

export const targetKeyFor = (
  cityId: string | null | undefined,
  segment: string,
) => `customer:home:${cityId ?? 'global'}:${segment}`;

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function parseVersion(value: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error('Version must use MAJOR.MINOR.PATCH');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

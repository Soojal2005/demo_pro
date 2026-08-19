/**
 * Prisma stores all of these as plain `String` columns (matching the
 * original `character varying` shape rather than native Postgres enums),
 * so the generated Prisma types are just `string`. These aliases are the
 * TS-side source of truth for which literal values are actually valid.
 */
/** The array, so a DTO can validate against the same list the type is built from. */
export const PRO_STATUSES = [
  'applied',
  'under_review',
  'approved',
  'suspended',
  'rejected',
] as const;

export type ProStatus = (typeof PRO_STATUSES)[number];

/** The array, so a DTO can validate against the same list the type is built from. */
export const QUEUE_STATUSES = [
  'pending',
  'docs_review',
  'call_pending',
  'changes_requested',
  'approved',
  'rejected',
] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export type DocumentSource = 'manual';
export type DocumentStatus = 'pending' | 'verified' | 'rejected';
export type ReferredByType = 'pro' | 'customer' | 'none';
export type ApplicationDecision = 'approved' | 'rejected' | 'changes_requested';
export type VerifiedByType = 'system' | 'admin';
export type DocumentGender = 'male' | 'female' | 'transgender';
export type Proficiency = 'trainee' | 'skilled' | 'expert';

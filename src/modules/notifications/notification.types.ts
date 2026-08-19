import type { Prisma } from '../../prisma/client';
import type { ActorType } from '../../common/types/authenticated-user.type';

export const NOTIFICATION_CHANNELS = ['push', 'whatsapp', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type PushPlatform = 'android' | 'ios';

export interface NotificationIntent {
  eventKey: string;
  dedupeKey: string;
  templateKey: string;
  recipientType: ActorType;
  recipientId: string;
  bookingId?: string;
  variables: Record<string, string | number | boolean | null>;
}

export interface ProviderMessage {
  channel: NotificationChannel;
  token?: string;
  platform?: string;
  phone?: string;
  title?: string;
  body: string;
  templateName?: string;
  variables: Record<string, string>;
  data: Record<string, string>;
}

export interface ProviderResult {
  accepted: boolean;
  provider: string;
  providerReference?: string;
  permanentFailure?: boolean;
  failureCode?: string;
  failureReason?: string;
}

export type NotificationTx = Pick<
  Prisma.TransactionClient,
  'notificationOutbox'
>;

export function recipientForeignKey(
  type: ActorType,
  id: string,
): { customerId?: string; proId?: string; adminUserId?: string } {
  if (type === 'customer') return { customerId: id };
  if (type === 'pro') return { proId: id };
  return { adminUserId: id };
}

export function renderTemplate(
  source: string,
  variables: Record<string, unknown>,
): string {
  return source.replace(/\{\{([a-zA-Z0-9_]+)}}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    if (['string', 'number', 'boolean', 'bigint'].includes(typeof value))
      return `${value as string | number | boolean | bigint}`;
    return '';
  });
}

export function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  return `${phone.slice(0, Math.max(0, phone.length - 4)).replace(/\d/g, '*')}${phone.slice(-4)}`;
}

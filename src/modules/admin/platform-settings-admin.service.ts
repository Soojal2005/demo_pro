import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { apiError } from '../../common/utils';
import { COMMISSION_SETTINGS } from '../commission/commission.types';
import { GEO_SETTINGS } from '../geo/geo.types';
import { PAYMENT_SETTINGS } from '../payments/payments.types';
import { REVIEW_SETTINGS } from '../reviews/reviews.types';
import { TRAINING_SETTINGS } from '../training/training.types';

type Kind = 'number' | 'integer' | 'boolean';
export interface Definition {
  kind: Kind;
  min?: number;
  max?: number;
  description: string;
}

const DEFINITIONS: Record<string, Definition> = {
  'no_start.graceWindowMinutes': {
    kind: 'integer',
    min: 1,
    max: 240,
    description: 'Minutes after arrival before a no-start incident.',
  },
  'assignment.ackWindowSeconds': {
    kind: 'integer',
    min: 5,
    max: 300,
    description: 'Seconds a Pro has to acknowledge an assignment.',
  },
  'dispatch.candidatePoolSize': {
    kind: 'integer',
    min: 1,
    max: 100,
    description: 'Maximum candidate pool size.',
  },
  'dispatch.maxAttempts': {
    kind: 'integer',
    min: 1,
    max: 20,
    description: 'Assignment attempts before exhaustion.',
  },
  'rotation.cooldownJobs': {
    kind: 'integer',
    min: 0,
    max: 100,
    description: 'Recent household jobs considered by Pro rotation.',
  },
  'dispatch.ratingPriorMean': {
    kind: 'number',
    min: 0,
    max: 5,
    description: 'Bayesian prior rating mean.',
  },
  'dispatch.ratingPriorWeight': {
    kind: 'number',
    min: 0,
    max: 1000,
    description: 'Bayesian prior rating weight.',
  },
  'dispatch.travelSoftTargetMinutes': {
    kind: 'number',
    min: 1,
    max: 240,
    description: 'Travel-time scoring target.',
  },
  'dispatch.assumedSpeedKmph': {
    kind: 'number',
    min: 1,
    max: 200,
    description: 'Fallback travel-speed estimate.',
  },
  'dispatch.neighbourMarginKm': {
    kind: 'number',
    min: 0,
    max: 100,
    description: 'Neighbour search margin.',
  },
  'dispatch.allowWidenBeyondArea': {
    kind: 'boolean',
    description: 'Allow dispatch to widen beyond the booking area.',
  },
  'booking.cancellationFeeAmount': {
    kind: 'number',
    min: 0,
    max: 100000,
    description: 'Cancellation fee in rupees.',
  },
  'booking.paymentHoldWindowMinutes': {
    kind: 'integer',
    min: 1,
    max: 1440,
    description: 'Unpaid booking hold duration.',
  },
  'booking.chatWindowHoursAfterCompletion': {
    kind: 'integer',
    min: 0,
    max: 720,
    description:
      'Hours after completion in which booking chat remains writable.',
  },
  'booking.startOtpMaxAttempts': {
    kind: 'integer',
    min: 1,
    max: 20,
    description: 'Maximum start OTP attempts.',
  },
  'booking.taxPercent': {
    kind: 'number',
    min: 0,
    max: 100,
    description: 'Tax component percentage.',
  },
  'booking.recurringGenerateAheadDays': {
    kind: 'integer',
    min: 1,
    max: 90,
    description: 'Days ahead generated for recurring plans.',
  },
  [REVIEW_SETTINGS.windowDays.key]: {
    kind: 'integer',
    min: 1,
    max: 365,
    description: 'Days after completion in which a review may be submitted.',
  },
  [REVIEW_SETTINGS.maxPhotos.key]: {
    kind: 'integer',
    min: 0,
    max: 10,
    description: 'Maximum review photos.',
  },
  [TRAINING_SETTINGS.gateActivation.key]: {
    kind: 'boolean',
    description: 'Enforce mandatory training for service activation.',
  },
  [TRAINING_SETTINGS.maxQuizAttempts.key]: {
    kind: 'integer',
    min: 1,
    max: 20,
    description: 'Quiz attempts before a training lock.',
  },
  [TRAINING_SETTINGS.quizPassPercent.key]: {
    kind: 'number',
    min: 1,
    max: 100,
    description: 'Default training quiz pass percentage.',
  },
  [PAYMENT_SETTINGS.cashEnabled]: {
    kind: 'boolean',
    description: 'Enable cash bookings.',
  },
  [PAYMENT_SETTINGS.cashCeiling]: {
    kind: 'number',
    min: 0,
    max: 1000000,
    description: 'Maximum cash a Pro may carry.',
  },
  [PAYMENT_SETTINGS.orderValidityMinutes]: {
    kind: 'integer',
    min: 1,
    max: 1440,
    description: 'Razorpay order validity in minutes.',
  },
  [PAYMENT_SETTINGS.reconciliationVarianceTolerance]: {
    kind: 'number',
    min: 0,
    max: 100000,
    description: 'Allowed reconciliation variance in rupees.',
  },
  [PAYMENT_SETTINGS.webhookDedupeTtlDays]: {
    kind: 'integer',
    min: 1,
    max: 365,
    description: 'Razorpay webhook deduplication TTL in days.',
  },
  [GEO_SETTINGS.defaultCellSizeKm]: {
    kind: 'number',
    min: 0.1,
    max: 100,
    description: 'Default generated service-area cell size.',
  },
  [GEO_SETTINGS.enforceAreaServiceAvailability]: {
    kind: 'boolean',
    description: 'Enforce service availability in resolved areas.',
  },
  [COMMISSION_SETTINGS.PAYOUT_PERIOD_DAYS]: {
    kind: 'integer',
    min: 1,
    max: 90,
    description: 'Days in a payout batch period.',
  },
  [COMMISSION_SETTINGS.PAYOUT_MINIMUM_NET]: {
    kind: 'number',
    min: 0,
    max: 1000000,
    description: 'Minimum net amount eligible for payout.',
  },
  [COMMISSION_SETTINGS.AUTO_APPROVE_AFTER_HOURS]: {
    kind: 'integer',
    min: 0,
    max: 720,
    description: 'Hours before a commission may be auto-approved.',
  },
  [COMMISSION_SETTINGS.SWEEPER_LOOKBACK_HOURS]: {
    kind: 'integer',
    min: 1,
    max: 8760,
    description: 'Missing-commission sweeper lookback window.',
  },
  'reporting.customerActiveDays': {
    kind: 'integer',
    min: 1,
    max: 365,
    description: 'Active customer lifecycle window.',
  },
  'reporting.customerLapsedDays': {
    kind: 'integer',
    min: 2,
    max: 1095,
    description: 'Customer lapsed threshold.',
  },
};

@Injectable()
export class PlatformSettingsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(cityId?: string, key?: string) {
    const rows = await this.prisma.platformSetting.findMany({
      where: {
        ...(key ? { key } : {}),
        ...(cityId ? { OR: [{ cityId: null }, { cityId }] } : {}),
      },
      orderBy: [{ key: 'asc' }, { cityId: 'asc' }],
    });
    const keys = key
      ? [key]
      : [
          ...new Set([
            ...Object.keys(DEFINITIONS),
            ...rows.map((row) => row.key),
          ]),
        ];
    return keys.map((settingKey) => {
      const global =
        rows.find((row) => row.key === settingKey && row.cityId === null) ??
        null;
      const override = cityId
        ? (rows.find(
            (row) => row.key === settingKey && row.cityId === cityId,
          ) ?? null)
        : null;
      return {
        key: settingKey,
        definition: DEFINITIONS[settingKey] ?? null,
        global,
        cityOverride: override,
        effectiveValue: override?.value ?? global?.value ?? null,
        source: override ? 'city' : global ? 'global' : 'unset',
      };
    });
  }

  async upsert(
    key: string,
    value: string,
    cityId: string | undefined,
    adminId: string,
  ) {
    const definition = DEFINITIONS[key];
    if (!definition)
      throw apiError('Unknown platform setting key', HttpStatus.BAD_REQUEST);
    this.validate(key, value, definition);
    if (
      key === 'reporting.customerLapsedDays' ||
      key === 'reporting.customerActiveDays'
    ) {
      const otherKey = key.endsWith('LapsedDays')
        ? 'reporting.customerActiveDays'
        : 'reporting.customerLapsedDays';
      const other = await this.prisma.platformSetting.findFirst({
        where: {
          key: otherKey,
          OR: [{ cityId: cityId ?? null }, { cityId: null }],
        },
        orderBy: { cityId: 'desc' },
      });
      const active = key.endsWith('ActiveDays')
        ? Number(value)
        : Number(other?.value ?? 30);
      const lapsed = key.endsWith('LapsedDays')
        ? Number(value)
        : Number(other?.value ?? 90);
      if (active >= lapsed)
        throw apiError(
          'customerActiveDays must be less than customerLapsedDays',
          HttpStatus.BAD_REQUEST,
        );
    }
    if (cityId) {
      const city = await this.prisma.city.findUnique({
        where: { id: cityId },
        select: { id: true },
      });
      if (!city) throw apiError('City not found', HttpStatus.NOT_FOUND);
    }
    const existing = await this.prisma.platformSetting.findFirst({
      where: { key, cityId: cityId ?? null },
    });
    if (existing)
      return this.prisma.platformSetting.update({
        where: { id: existing.id },
        data: {
          value,
          description: definition.description,
          updatedByAdminId: adminId,
        },
      });
    return this.prisma.platformSetting.create({
      data: {
        key,
        cityId: cityId ?? null,
        value,
        description: definition.description,
        updatedByAdminId: adminId,
      },
    });
  }

  async removeOverride(key: string, cityId: string) {
    const deleted = await this.prisma.platformSetting.deleteMany({
      where: { key, cityId },
    });
    if (!deleted.count)
      throw apiError('City override not found', HttpStatus.NOT_FOUND);
    return { key, cityId, reset: true };
  }

  private validate(key: string, value: string, definition: Definition): void {
    if (definition.kind === 'boolean') {
      if (value !== 'true' && value !== 'false')
        throw apiError(`${key} must be true or false`, HttpStatus.BAD_REQUEST);
      return;
    }
    const numeric = Number(value);
    if (
      !Number.isFinite(numeric) ||
      (definition.kind === 'integer' && !Number.isInteger(numeric)) ||
      (definition.min !== undefined && numeric < definition.min) ||
      (definition.max !== undefined && numeric > definition.max)
    ) {
      const type =
        definition.kind === 'integer' ? 'a whole number' : 'a number';
      throw apiError(
        `${key} must be ${type} between ${definition.min} and ${definition.max}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}

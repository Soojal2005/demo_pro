import { CommissionAdminService } from './commission-admin.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { DeductionsService } from './deductions.service';

/** Matches the sibling specs: only `toString()` is ever used on these. */
const decimal = (value: string) => ({ toString: () => value });

function buildDeps() {
  const prisma = {
    payoutDeduction: { findMany: jest.fn() },
  };
  const deductions = { outstandingTotal: jest.fn().mockResolvedValue('50.00') };
  return { prisma, deductions };
}

function build(deps: ReturnType<typeof buildDeps>) {
  return new CommissionAdminService(
    deps.prisma as unknown as PrismaService,
    deps.deductions as unknown as DeductionsService,
  );
}

/** A row exactly as Prisma hands it over, internal columns and all. */
function aRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ded-1',
    createdAt: new Date('2026-08-18T07:14:48.560Z'),
    updatedAt: new Date('2026-08-18T07:14:48.560Z'),
    proId: 'pro-1',
    amount: decimal('50'),
    consumedAmount: decimal('0'),
    kind: 'manual',
    reason: 'Replacement uniform',
    sourceCommissionId: 'comm-1',
    dedupeKey: null,
    consumedByPayoutId: null,
    fullyConsumedAt: null,
    waivedAt: null,
    waiveReason: null,
    waivedByAdminId: null,
    raisedByAdminId: 'admin-1',
    sourceCommission: { booking: { bookingNumber: 'HB-2026-000001' } },
    ...overrides,
  };
}

describe('deductionsForPro', () => {
  /**
   * The trap this guards. Spreading the Prisma row published `consumedAmount`,
   * `createdAt` and `consumedByPayoutId` under names the documented
   * `DeductionLineDto` does not use — so a client generated from `/docs/json`
   * read `recovered`, `raisedAt` and `payoutId` as `undefined`, on a money
   * screen, with nothing to say it had gone wrong.
   */
  it('answers in the shape the API documents', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([aRow()]);

    const statement = await build(deps).deductionsForPro('pro-1');

    expect(statement.items[0]).toEqual({
      id: 'ded-1',
      amount: '50',
      recovered: '0',
      kind: 'manual',
      reason: 'Replacement uniform',
      bookingNumber: 'HB-2026-000001',
      raisedAt: new Date('2026-08-18T07:14:48.560Z'),
      settledAt: null,
      payoutId: null,
      waivedAt: null,
      waiveReason: null,
    });
  });

  it('does not leak the dedupe key or the admin ids', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([aRow()]);

    const statement = await build(deps).deductionsForPro('pro-1');

    expect(statement.items[0]).not.toHaveProperty('dedupeKey');
    expect(statement.items[0]).not.toHaveProperty('raisedByAdminId');
    expect(statement.items[0]).not.toHaveProperty('waivedByAdminId');
  });

  /**
   * The Pro-facing statement filters these out; this one must not. A waived row
   * that vanishes from the admin's view is a debt the next person raises again.
   */
  it('keeps a waived row visible, and says why it was waived', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([
      aRow({
        waivedAt: new Date('2026-08-18T09:00:00.000Z'),
        waiveReason: 'Raised in error',
      }),
    ]);

    const statement = await build(deps).deductionsForPro('pro-1');

    expect(statement.items).toHaveLength(1);
    expect(statement.items[0].waiveReason).toBe('Raised in error');
  });

  it('reports a booking number of null when nothing sourced it', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([
      aRow({ sourceCommissionId: null, sourceCommission: null }),
    ]);

    const statement = await build(deps).deductionsForPro('pro-1');

    expect(statement.items[0].bookingNumber).toBeNull();
  });
});

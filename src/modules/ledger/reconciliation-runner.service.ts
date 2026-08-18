import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { ReconciliationRun } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  fromPaise,
  rupeesDifference,
  toPaise,
} from '../payments/payments.money';
import {
  ReconciliationService,
  type Discrepancy,
} from '../payments/reconciliation.service';
import { ProCountersService } from '../pros/pro-counters.service';
import { LedgerBalancesService } from './ledger-balances.service';
import { LedgerService } from './ledger.service';
import {
  cashInHandAccount,
  payableToProAccount,
  sourceRef,
  type ReconciliationScope,
} from './ledger.types';

/**
 * Feature 4 — the nightly cross-check, and features 5 and 7 with it.
 *
 * **Extends module 7 rather than replacing it.** `ReconciliationService`
 * already answers the money and cash questions across 300 lines and six
 * discrepancy kinds; its own comment says the missing half is "the history of
 * having asked". This class is that history, plus four checks that only make
 * sense once a ledger exists.
 *
 * Rebuilding any of that here would have produced a second implementation of
 * the same query, free to disagree with the first.
 */
@Injectable()
export class ReconciliationRunnerService {
  private readonly logger = new Logger(ReconciliationRunnerService.name);

  /** Bounded, so one run cannot walk the whole table into memory. */
  private static readonly MAX_ROWS = 1_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: ReconciliationService,
    private readonly counters: ProCountersService,
    private readonly ledger: LedgerService,
    private readonly balances: LedgerBalancesService,
  ) {}

  /**
   * One run, recorded whatever happens.
   *
   * The row is opened before any work and closed in a `finally`, so a run that
   * crashes leaves `status = failed` with a reason rather than a `running` row
   * that never resolves. "The job died" and "the job found nothing" must not
   * look the same.
   */
  async run(input: {
    scope?: ReconciliationScope;
    from?: Date;
    to?: Date;
    rebuildCounters?: boolean;
  }): Promise<ReconciliationRun> {
    const scope = input.scope ?? 'all';
    const to = input.to ?? new Date();
    const from = input.from ?? new Date(to.getTime() - 24 * 3_600_000);

    if (from >= to) {
      throw apiError('`from` must be before `to`', HttpStatus.BAD_REQUEST);
    }

    const startedAt = new Date();
    const run = await this.prisma.reconciliationRun.create({
      data: { runDate: startedAt, scope, startedAt, status: 'running' },
    });

    const discrepancies: Discrepancy[] = [];
    let ordersScanned = 0;
    let bookingsScanned = 0;
    let entriesScanned = 0;
    let countersRebuilt = false;

    try {
      // `ledger` is the one scope module 7 knows nothing about, so it is the
      // one that skips this half.
      if (scope !== 'ledger') {
        const report = await this.payments.run({
          scope: scope === 'all' || scope === 'both' ? 'both' : scope,
          from,
          to,
        });
        ordersScanned = report.ordersScanned;
        bookingsScanned = report.bookingsScanned;
        discrepancies.push(...report.discrepancies);
      }

      if (scope === 'ledger' || scope === 'all') {
        const ledgerFindings = await this.reconcileLedger(from, to);
        entriesScanned = ledgerFindings.entriesScanned;
        discrepancies.push(...ledgerFindings.discrepancies);
      }

      /**
       * Feature 7, satisfied by one call. `ProCountersService.rebuildAll`
       * already rebuilds Pro rating and completed-job counts from source with
       * its own Redis lock and drift logging — a second implementation here
       * would be a second answer to the same question.
       *
       * Returns false when another instance holds the lock, which is not a
       * failure: the rebuild is happening, just not in this process.
       */
      if (input.rebuildCounters ?? scope === 'all') {
        countersRebuilt = await this.counters.rebuildAll();
      }

      return await this.close(run.id, {
        status: 'completed',
        discrepancies,
        ordersScanned,
        bookingsScanned,
        entriesScanned,
        countersRebuilt,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Reconciliation run ${run.id} failed: ${reason}`);

      // The discrepancies found before the crash are still real findings and
      // are persisted; the run is just marked as incomplete so nobody reads
      // "0 discrepancies" as "everything is fine".
      return this.close(run.id, {
        status: 'failed',
        failureReason: reason,
        discrepancies,
        ordersScanned,
        bookingsScanned,
        entriesScanned,
        countersRebuilt,
      });
    }
  }

  /**
   * The four checks that only exist once there is a ledger.
   *
   * All four ask the same question from different directions: does the ledger
   * agree with the tables it was written from? Nothing is corrected — a
   * discrepancy is a question for a human, and making the books match the
   * source would destroy the evidence that they ever differed.
   */
  private async reconcileLedger(
    from: Date,
    to: Date,
  ): Promise<{ entriesScanned: number; discrepancies: Discrepancy[] }> {
    const discrepancies: Discrepancy[] = [];

    // --- 1 · the chain itself -------------------------------------------
    const integrity = await this.ledger.verify();
    for (const chainBreak of integrity.breaks) {
      discrepancies.push({
        kind: 'chain_broken' as Discrepancy['kind'],
        reference: `sequence:${chainBreak.sequence}`,
        ours: chainBreak.expected,
        theirs: chainBreak.found,
        variance: null,
        detail:
          `The ledger chain fails at sequence ${chainBreak.sequence} (${chainBreak.reason}). ` +
          'Entries are append-only and hash-linked, so this means a row was changed, ' +
          'removed or inserted outside the application.',
      });
    }

    // --- 2 · captured orders with no entry ------------------------------
    const captured = await this.prisma.order.findMany({
      where: { status: 'paid', paidAt: { gte: from, lte: to } },
      select: { id: true, receipt: true, amountPaid: true },
      take: ReconciliationRunnerService.MAX_ROWS,
    });

    for (const order of captured) {
      const entry = await this.prisma.ledgerEntry.findUnique({
        where: { sourceRef: sourceRef.capture(order.id) },
      });

      if (!entry) {
        discrepancies.push({
          kind: 'missing_ledger_entry' as Discrepancy['kind'],
          reference: order.receipt,
          ours: null,
          theirs: order.amountPaid.toString(),
          variance: order.amountPaid.toString(),
          detail: `Order ${order.receipt} was captured but has no ledger entry.`,
        });
        continue;
      }

      if (
        toPaise(entry.amount.toString()) !==
        toPaise(order.amountPaid.toString())
      ) {
        discrepancies.push({
          kind: 'ledger_amount_mismatch' as Discrepancy['kind'],
          reference: order.receipt,
          ours: entry.amount.toString(),
          theirs: order.amountPaid.toString(),
          variance: rupeesDifference(
            entry.amount.toString(),
            order.amountPaid.toString(),
          ),
          detail: `Ledger entry ${entry.sequence} disagrees with the amount captured on ${order.receipt}.`,
        });
      }
    }

    // --- 3 · commissions with no accrual --------------------------------
    const commissions = await this.prisma.bookingCommission.findMany({
      where: { computedAt: { gte: from, lte: to }, reversedAt: null },
      select: {
        id: true,
        commissionAmount: true,
        booking: { select: { bookingNumber: true } },
      },
      take: ReconciliationRunnerService.MAX_ROWS,
    });

    for (const commission of commissions) {
      const entry = await this.prisma.ledgerEntry.findUnique({
        where: { sourceRef: sourceRef.accrual(commission.id) },
      });

      if (!entry) {
        discrepancies.push({
          kind: 'missing_ledger_entry' as Discrepancy['kind'],
          reference: commission.booking.bookingNumber,
          ours: null,
          theirs: commission.commissionAmount.toString(),
          variance: commission.commissionAmount.toString(),
          detail: `Commission on ${commission.booking.bookingNumber} was computed but never booked.`,
        });
      } else if (
        toPaise(entry.amount.toString()) !==
        toPaise(commission.commissionAmount.toString())
      ) {
        discrepancies.push({
          kind: 'ledger_amount_mismatch' as Discrepancy['kind'],
          reference: commission.booking.bookingNumber,
          ours: entry.amount.toString(),
          theirs: commission.commissionAmount.toString(),
          variance: rupeesDifference(
            entry.amount.toString(),
            commission.commissionAmount.toString(),
          ),
          detail: `Ledger entry ${entry.sequence} disagrees with the commission computed on ${commission.booking.bookingNumber}.`,
        });
      }
    }

    // --- 4 · a settled Pro should owe and be owed nothing ---------------
    //
    // The strongest check in the module, because it tests the whole chain of
    // events rather than one row: accruals and incentives credit
    // `payable:pro`, settlement debits it by the net plus every deduction
    // recovered. A Pro whose payouts have all been paid must sit at zero. Any
    // other figure means an entry is missing, duplicated, or wrong.
    const paidPayouts = await this.prisma.commissionPayout.findMany({
      where: { status: 'paid', paidAt: { gte: from, lte: to } },
      select: { proId: true },
      distinct: ['proId'],
      take: ReconciliationRunnerService.MAX_ROWS,
    });

    for (const { proId } of paidPayouts) {
      const stillUnpaid = await this.prisma.bookingCommission.count({
        where: { proId, status: { in: ['pending', 'approved'] } },
      });
      // Only meaningful when nothing is still in flight — otherwise the
      // balance is correctly non-zero and reporting it would be noise.
      if (stillUnpaid > 0) continue;

      const balance = await this.balances.balanceOf(payableToProAccount(proId));
      if (toPaise(balance) !== 0) {
        discrepancies.push({
          kind: 'ledger_amount_mismatch' as Discrepancy['kind'],
          reference: proId,
          ours: balance,
          theirs: '0.00',
          variance: balance,
          detail:
            `Pro ${proId} has no unpaid commissions, so ${payableToProAccount(proId)} ` +
            `should be zero and is ${balance}. An entry is missing or duplicated.`,
        });
      }
    }

    // --- 5 · the cash cache against the books ---------------------------
    const prosWithCash = await this.prisma.pro.findMany({
      where: { cashInHand: { not: 0 } },
      select: { id: true, cashInHand: true },
      take: ReconciliationRunnerService.MAX_ROWS,
    });

    for (const pro of prosWithCash) {
      const booked = await this.balances.balanceOf(cashInHandAccount(pro.id));
      if (toPaise(booked) !== toPaise(pro.cashInHand.toString())) {
        discrepancies.push({
          kind: 'cash_balance_drift',
          reference: pro.id,
          ours: pro.cashInHand.toString(),
          theirs: booked,
          variance: rupeesDifference(pro.cashInHand.toString(), booked),
          detail: `Pro.cashInHand says ${pro.cashInHand.toString()}; the ledger says ${booked}.`,
        });
      }
    }

    return { entriesScanned: integrity.entriesChecked, discrepancies };
  }

  private async close(
    runId: string,
    result: {
      status: 'completed' | 'failed';
      failureReason?: string;
      discrepancies: Discrepancy[];
      ordersScanned: number;
      bookingsScanned: number;
      entriesScanned: number;
      countersRebuilt: boolean;
    },
  ): Promise<ReconciliationRun> {
    // Magnitudes, and stripped of the sign before `toPaise` sees it.
    //
    // `rupeesDifference` reports a signed figure, and `toPaise` rejects a
    // negative outright — so summing these naively throws the moment the ledger
    // records *less* than its source, which is exactly the case worth catching.
    // Magnitudes rather than a signed sum for a second reason: two errors in
    // opposite directions are two problems, and a total of zero would report
    // them as none.
    const variance = result.discrepancies.reduce(
      (total, row) =>
        total + (row.variance ? toPaise(row.variance.replace('-', '')) : 0),
      0,
    );

    if (result.discrepancies.length > 0) {
      await this.prisma.reconciliationDiscrepancy.createMany({
        data: result.discrepancies.map((row) => ({
          runId,
          kind: row.kind,
          reference: row.reference,
          ours: row.ours,
          theirs: row.theirs,
          variance: row.variance,
          detail: row.detail,
        })),
      });

      this.logger.warn(
        `Reconciliation run ${runId}: ${result.discrepancies.length} discrepancy(ies), ` +
          `${fromPaise(variance)} total variance. Nothing has been corrected.`,
      );
    }

    return this.prisma.reconciliationRun.update({
      where: { id: runId },
      data: {
        status: result.status,
        failureReason: result.failureReason ?? null,
        completedAt: new Date(),
        ordersScanned: result.ordersScanned,
        bookingsScanned: result.bookingsScanned,
        entriesScanned: result.entriesScanned,
        countersRebuilt: result.countersRebuilt,
        discrepancyCount: result.discrepancies.length,
        totalVarianceAmount: fromPaise(variance),
      },
    });
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  async runs(query: { page?: number; limit?: number; status?: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = query.status ? { status: query.status } : {};

    const [total, items] = await Promise.all([
      this.prisma.reconciliationRun.count({ where }),
      this.prisma.reconciliationRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { page, limit, total, items };
  }

  async runDetail(id: string) {
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id },
      include: {
        discrepancies: {
          // Unresolved first: a repeat finding on tonight's run must not bury
          // yesterday's unanswered one.
          orderBy: [{ resolvedAt: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!run)
      throw apiError('Reconciliation run not found', HttpStatus.NOT_FOUND);
    return run;
  }

  /** Everything still open, across every run. The actual work queue. */
  async openDiscrepancies(query: {
    page?: number;
    limit?: number;
    kind?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const where = {
      resolvedAt: null,
      ...(query.kind ? { kind: query.kind } : {}),
    };

    // Counted, like `runs()` above. Without it a caller cannot tell a last page
    // from a full one, and on this list in particular the count *is* the
    // answer — "how much is still unanswered" is the question a work queue
    // exists to settle.
    const [total, items] = await Promise.all([
      this.prisma.reconciliationDiscrepancy.count({ where }),
      this.prisma.reconciliationDiscrepancy.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { page, limit, total, items };
  }

  /**
   * Close one finding.
   *
   * Notes and attribution, and nothing else — no states, no assignment, no
   * threads. Those are a ticket system, and module 11 is where one belongs if
   * it turns out to be needed.
   */
  async resolve(id: string, notes: string, adminId: string) {
    const row = await this.prisma.reconciliationDiscrepancy.findUnique({
      where: { id },
    });
    if (!row) throw apiError('Discrepancy not found', HttpStatus.NOT_FOUND);
    if (row.resolvedAt) {
      throw apiError(
        'This discrepancy has already been resolved',
        HttpStatus.CONFLICT,
      );
    }

    return this.prisma.reconciliationDiscrepancy.update({
      where: { id },
      data: {
        resolvedAt: new Date(),
        resolutionNotes: notes,
        resolvedByAdminId: adminId,
      },
    });
  }
}

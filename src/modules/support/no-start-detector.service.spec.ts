import { NoStartDetectorService } from './no-start-detector.service';

const NOW = new Date('2026-08-17T12:00:00.000Z');
const ARRIVED = new Date('2026-08-17T11:00:00.000Z'); // 60 minutes earlier

function aBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'book-1',
    bookingNumber: 'HB-2026-000123',
    customerId: 'cus-1',
    proId: 'pro-1',
    arrivedAt: ARRIVED,
    startOtpAttempts: 2,
    address: { cityId: 'city-1' },
    ...overrides,
  };
}

function build(options: { bookings?: unknown[]; grace?: number } = {}) {
  const prisma = {
    booking: {
      findMany: jest.fn().mockResolvedValue(options.bookings ?? [aBooking()]),
    },
    supportTicket: { findMany: jest.fn().mockResolvedValue([]) },
    platformSetting: { findFirst: jest.fn().mockResolvedValue(null) },
  };

  const settings = {
    getNumber: jest.fn((_key: string, fallback: number) =>
      Promise.resolve(options.grace ?? fallback),
    ),
  };

  const tickets = {
    raiseSystemTicket: jest.fn().mockResolvedValue({ id: 'tkt-1' }),
    autoResolveSystemTicket: jest.fn().mockResolvedValue(undefined),
  };

  const service = new NoStartDetectorService(
    prisma as never,
    settings as never,
    tickets as never,
  );

  return { service, prisma, settings, tickets };
}

describe('no-start detection', () => {
  it('raises an incident once the grace window has passed', async () => {
    const { service, tickets } = build({ grace: 30 });

    const result = await service.sweep(NOW);

    expect(result.raised).toBe(1);
    expect(tickets.raiseSystemTicket).toHaveBeenCalledTimes(1);
  });

  it('leaves a job alone while it is still inside the window', async () => {
    const { service, tickets } = build({ grace: 90 });

    const result = await service.sweep(NOW);

    expect(result.raised).toBe(0);
    expect(tickets.raiseSystemTicket).not.toHaveBeenCalled();
  });

  /**
   * Feature 12: the ticket carries "the grace window that was applied".
   *
   * `graceSource` is there because ops reading `30` cannot tell whether that
   * was their city's setting or the code's fallback — which is the first thing
   * they ask when the number looks wrong.
   */
  it('records the window that was applied and where it came from', async () => {
    const { service, tickets } = build({ grace: 45 });

    await service.sweep(NOW);

    expect(
      tickets.raiseSystemTicket.mock.calls[0][0].contextJson,
    ).toMatchObject({
      graceWindowMinutes: 45,
      graceSource: 'fallback',
      arrivedAt: ARRIVED.toISOString(),
      cityId: 'city-1',
      startOtpAttempts: 2,
    });
  });

  it('reports the source as `city` when the city overrides the default', async () => {
    const { service, prisma } = build({ grace: 15 });
    prisma.platformSetting.findFirst.mockResolvedValue({ id: 'set-1' });

    await service.sweep(NOW);

    // Ops needs to know this number was theirs, not the code's.
    expect(prisma.platformSetting.findFirst).toHaveBeenCalled();
  });

  /**
   * `arrivedAt` is module 4's authoritative *first* arrival and deliberately
   * does not move on an `en_route → arrived` repeat — precisely so a Pro
   * cannot extend the window by stepping away and returning. That is what lets
   * the dedupe key be per-booking with no timestamp in it: one incident per
   * booking, forever.
   */
  it('keys the incident on the booking alone, so a sweep cannot raise it twice', async () => {
    const { service, tickets } = build({ grace: 30 });

    await service.sweep(NOW);

    expect(tickets.raiseSystemTicket.mock.calls[0][0].systemKey).toBe(
      'no_start:book-1',
    );
  });

  it('marks the incident high priority and files it under no_start', async () => {
    const { service, tickets } = build({ grace: 30 });

    await service.sweep(NOW);

    expect(tickets.raiseSystemTicket.mock.calls[0][0]).toMatchObject({
      category: 'no_start',
      priority: 'high',
      bookingId: 'book-1',
    });
  });

  /**
   * A single `now() - 30min` cutoff would apply the wrong window everywhere a
   * city overrides the default. Candidates are grouped by city and each group
   * gets its own cutoff — and the settings read happens once per city, not
   * once per booking.
   */
  it('reads the window once per city, not once per booking', async () => {
    const { service, settings } = build({
      grace: 30,
      bookings: [
        aBooking({ id: 'a' }),
        aBooking({ id: 'b' }),
        aBooking({ id: 'c', address: { cityId: 'city-2' } }),
      ],
    });

    await service.sweep(NOW);

    expect(settings.getNumber).toHaveBeenCalledTimes(2);
  });

  it('scopes the settings read to the booking’s own city', async () => {
    const { service, settings } = build({ grace: 30 });

    await service.sweep(NOW);

    expect(settings.getNumber).toHaveBeenCalledWith(
      'no_start.graceWindowMinutes',
      30,
      'city-1',
    );
  });

  it('counts nothing when the sweep finds no arrived-and-not-started jobs', async () => {
    const { service, tickets } = build({ bookings: [] });

    const result = await service.sweep(NOW);

    expect(result).toEqual({ scanned: 0, raised: 0, autoResolved: 0 });
    expect(tickets.raiseSystemTicket).not.toHaveBeenCalled();
  });

  it('only looks at jobs that arrived, have not started and are not cancelled', async () => {
    const { service, prisma } = build();

    await service.sweep(NOW);

    expect(prisma.booking.findMany.mock.calls[0][0].where).toEqual({
      status: 'arrived',
      startedAt: null,
      cancelledAt: null,
      arrivedAt: { not: null },
    });
  });
});

// =====================================================================
// Feature 13 — never surfaced to the Pro
// =====================================================================

describe('feature 13 — the Pro is never told', () => {
  /**
   * A negative requirement gets a negative test.
   *
   * The detector has no `NotificationsService` at all — not an unused
   * dependency, none. That is the strongest form this assertion can take:
   * there is no code path from a no-start incident to a Pro's phone, because
   * there is nothing to call.
   */
  it('has no notification dependency it could reach the Pro through', () => {
    const { service } = build();

    const injected = Object.values(
      service as unknown as Record<string, unknown>,
    );
    const hasEnqueue = injected.some(
      (dep) =>
        typeof dep === 'object' &&
        dep !== null &&
        'enqueue' in (dep as Record<string, unknown>),
    );
    expect(hasEnqueue).toBe(false);
  });

  it('raises the incident without notifying anybody', async () => {
    const { service, tickets } = build({ grace: 30 });

    await service.sweep(NOW);

    // The only outbound call the sweep makes is the ticket write itself.
    expect(tickets.raiseSystemTicket).toHaveBeenCalledTimes(1);
    expect(tickets.autoResolveSystemTicket).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Auto-close
// =====================================================================

describe('incidents that fix themselves', () => {
  /**
   * Without this, every OTP delay longer than the grace window leaves ops a
   * ticket about a job that was already running by the time they opened it —
   * and a queue of self-resolved tickets is how ops learns to stop reading the
   * queue.
   */
  it('closes an incident once the job actually starts', async () => {
    const { service, prisma, tickets } = build({ bookings: [] });
    const startedAt = new Date('2026-08-17T11:40:00.000Z');
    prisma.supportTicket.findMany.mockResolvedValue([
      { id: 'tkt-1', bookingId: 'book-1' },
    ]);
    prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'book-1', status: 'started', startedAt }]);

    const result = await service.sweep(NOW);

    expect(result.autoResolved).toBe(1);
    expect(tickets.autoResolveSystemTicket).toHaveBeenCalledWith(
      'tkt-1',
      `Resolved automatically — the job started at ${startedAt.toISOString()}.`,
    );
  });

  it('closes an incident when the booking is cancelled instead', async () => {
    const { service, prisma, tickets } = build({ bookings: [] });
    prisma.supportTicket.findMany.mockResolvedValue([
      { id: 'tkt-1', bookingId: 'book-1' },
    ]);
    prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'book-1', status: 'cancelled', startedAt: null },
      ]);

    const result = await service.sweep(NOW);

    expect(result.autoResolved).toBe(1);
    expect(tickets.autoResolveSystemTicket.mock.calls[0][1]).toContain(
      'moved to cancelled',
    );
  });

  it('leaves an incident open while the job is still stuck at arrived', async () => {
    const { service, prisma, tickets } = build({ bookings: [] });
    prisma.supportTicket.findMany.mockResolvedValue([
      { id: 'tkt-1', bookingId: 'book-1' },
    ]);
    prisma.booking.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'book-1', status: 'arrived', startedAt: null },
      ]);

    const result = await service.sweep(NOW);

    expect(result.autoResolved).toBe(0);
    expect(tickets.autoResolveSystemTicket).not.toHaveBeenCalled();
  });
});

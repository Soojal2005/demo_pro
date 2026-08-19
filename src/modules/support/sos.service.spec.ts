import { HttpStatus } from '@nestjs/common';
import { SosService } from './sos.service';

const RAISED = new Date('2026-08-17T12:00:00.000Z');
const ACKED = new Date('2026-08-17T12:01:30.000Z'); // 90 seconds later

function anAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sos-1',
    raisedByType: 'customer',
    customerId: 'cus-1',
    proId: null,
    bookingId: 'book-1',
    lat: null,
    lng: null,
    raisedAt: RAISED,
    contextSnapshot: {},
    status: 'open',
    acknowledgedByAdminId: null,
    acknowledgedAt: null,
    resolvedByAdminId: null,
    resolvedAt: null,
    resolutionNotes: null,
    ...overrides,
  };
}

function aBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'book-1',
    bookingNumber: 'HB-2026-000123',
    status: 'started',
    customerId: 'cus-1',
    proId: 'pro-1',
    slotStartAt: RAISED,
    arrivedAt: RAISED,
    startedAt: RAISED,
    service: { name: 'Deep Cleaning' },
    address: {
      cityId: 'city-1',
      addressLine: '12 Vijay Nagar',
      pinLat: 22.7196,
      pinLng: 75.8577,
    },
    customer: { id: 'cus-1', fullName: 'Asha', phone: '+919000000001' },
    pro: {
      id: 'pro-1',
      fullName: 'Ravi',
      phone: '+919000000002',
      employeeCode: 'HP-0007',
    },
    ...overrides,
  };
}

// `booking: null` and an omitted `booking` mean different things here — the
// first is "the raiser has no live job", the second is "use the default one".
function build(options: { admins?: unknown[]; booking?: unknown } = {}) {
  const tx = {
    sosAlert: {
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(anAlert(args.data)),
      ),
    },
    notificationOutbox: { create: jest.fn() },
  };

  const prisma = {
    sosAlert: {
      findUnique: jest.fn().mockResolvedValue(anAlert()),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(anAlert(args.data)),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    booking: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.booking === undefined ? aBooking() : options.booking,
        ),
    },
    adminUser: {
      findMany: jest.fn().mockResolvedValue(
        options.admins ?? [
          {
            id: 'adm-1',
            cityScopeJson: [],
            role: { permissionCodes: ['safety.sos.respond'] },
          },
        ],
      ),
    },
    pro: { findUnique: jest.fn().mockResolvedValue({ cityId: 'city-1' }) },
    customerAddress: {
      findFirst: jest.fn().mockResolvedValue({ cityId: 'city-1' }),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const service = new SosService(prisma as never, notifications as never);
  return { service, prisma, tx, notifications };
}

const CUSTOMER = { id: 'cus-1', actorType: 'customer' as const };
const PRO = { id: 'pro-1', actorType: 'pro' as const };

// =====================================================================
// Raising
// =====================================================================

describe('raising an SOS', () => {
  /**
   * A phone that cannot get a fix must still be able to raise an alert. A
   * missing pin degrades the response; refusing the alert defeats the feature.
   */
  it('accepts an alert with no coordinates and no booking', async () => {
    const { service, tx } = build({ booking: null });

    await service.raise(CUSTOMER, 'customer', {});

    expect(tx.sosAlert.create).toHaveBeenCalledTimes(1);
    expect(tx.sosAlert.create.mock.calls[0][0].data).toMatchObject({
      raisedByType: 'customer',
      customerId: 'cus-1',
      bookingId: null,
      lat: null,
      lng: null,
    });
  });

  /**
   * `raisedByType` comes from the token. If it were ever taken from the body,
   * a customer could file an alert as a Pro.
   */
  it('takes the raiser type from the caller, not the payload', async () => {
    const { service, tx } = build();

    await service.raise(PRO, 'pro', { bookingId: 'book-1' });

    expect(tx.sosAlert.create.mock.calls[0][0].data).toMatchObject({
      raisedByType: 'pro',
      proId: 'pro-1',
    });
  });

  it('answers 404 for a booking the raiser does not own', async () => {
    const { service } = build({ booking: aBooking({ customerId: 'other' }) });

    await expect(
      service.raise(CUSTOMER, 'customer', { bookingId: 'book-1' }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  /**
   * The snapshot is written once and never re-derived. By the time ops opens
   * the alert the booking may be cancelled or reassigned, and the state that
   * mattered is the state at the moment somebody pressed the button.
   */
  it('freezes the booking context, phone numbers included', async () => {
    const { service, tx } = build();

    await service.raise(CUSTOMER, 'customer', { bookingId: 'book-1' });

    expect(
      tx.sosAlert.create.mock.calls[0][0].data.contextSnapshot,
    ).toMatchObject({
      bookingNumber: 'HB-2026-000123',
      serviceName: 'Deep Cleaning',
      addressText: '12 Vijay Nagar',
      addressLat: 22.7196,
      // An admin responding to a safety alert needs to call somebody.
      customer: { phone: '+919000000001' },
      pro: { phone: '+919000000002', employeeCode: 'HP-0007' },
    });
  });

  /**
   * The alert row and every notification are written in one transaction. A
   * committed alert nobody was told about is the failure this prevents.
   */
  it('enqueues the responder notifications inside the alert’s transaction', async () => {
    const { service, notifications, tx } = build();

    await service.raise(CUSTOMER, 'customer', { bookingId: 'book-1' });

    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
    expect(notifications.enqueue.mock.calls[0][1]).toBe(tx);
    expect(notifications.enqueue.mock.calls[0][0]).toMatchObject({
      recipientType: 'admin',
      recipientId: 'adm-1',
    });
  });
});

// =====================================================================
// Fan-out — feature 5
// =====================================================================

describe('who gets woken up', () => {
  it('notifies only admins holding safety.sos.respond', async () => {
    const { service, notifications } = build({
      admins: [
        {
          id: 'adm-1',
          cityScopeJson: [],
          role: { permissionCodes: ['safety.sos.respond'] },
        },
        {
          id: 'adm-2',
          cityScopeJson: [],
          role: { permissionCodes: ['booking.read'] },
        },
      ],
    });

    await service.raise(CUSTOMER, 'customer', { bookingId: 'book-1' });

    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
    expect(notifications.enqueue.mock.calls[0][0].recipientId).toBe('adm-1');
  });

  it('prefers admins scoped to the booking’s city', async () => {
    const { service, notifications } = build({
      admins: [
        {
          id: 'indore',
          cityScopeJson: ['city-1'],
          role: { permissionCodes: ['safety.sos.respond'] },
        },
        {
          id: 'bhopal',
          cityScopeJson: ['city-2'],
          role: { permissionCodes: ['safety.sos.respond'] },
        },
      ],
    });

    await service.raise(CUSTOMER, 'customer', { bookingId: 'book-1' });

    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
    expect(notifications.enqueue.mock.calls[0][0].recipientId).toBe('indore');
  });

  it('treats an empty city scope as platform-wide', async () => {
    const { service, notifications } = build({
      admins: [
        {
          id: 'national',
          cityScopeJson: [],
          role: { permissionCodes: ['safety.sos.respond'] },
        },
      ],
    });

    await service.raise(CUSTOMER, 'customer', { bookingId: 'book-1' });

    expect(notifications.enqueue.mock.calls[0][0].recipientId).toBe('national');
  });

  /**
   * The fallback is deliberate. An over-broad safety alert is a nuisance; an
   * unrouted one is the feature not working.
   */
  it('falls back to every permission holder when no scoped responder matches', async () => {
    const { service, notifications } = build({
      admins: [
        {
          id: 'bhopal',
          cityScopeJson: ['city-2'],
          role: { permissionCodes: ['safety.sos.respond'] },
        },
      ],
    });

    await service.raise(CUSTOMER, 'customer', { bookingId: 'book-1' });

    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
    expect(notifications.enqueue.mock.calls[0][0].recipientId).toBe('bhopal');
  });

  it('still writes the alert when nobody holds the permission at all', async () => {
    const { service, tx, notifications } = build({ admins: [] });

    await service.raise(CUSTOMER, 'customer', { bookingId: 'book-1' });

    // The alert is the durable record; the missing responder is a
    // configuration problem, and it is logged as an error.
    expect(tx.sosAlert.create).toHaveBeenCalledTimes(1);
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Ops
// =====================================================================

describe('acknowledgement', () => {
  /**
   * Two responders opening the same alert at once is the expected case. The
   * first write owns the record so the response-time metric is not rewritten
   * by whoever clicked last.
   */
  it('is idempotent — a second acknowledgement does not rewrite the first', async () => {
    const { service, prisma } = build();
    prisma.sosAlert.findUnique.mockResolvedValue(
      anAlert({
        status: 'acknowledged',
        acknowledgedAt: ACKED,
        acknowledgedByAdminId: 'adm-1',
      }),
    );

    const result = await service.acknowledge('sos-1', 'adm-2');

    expect(prisma.sosAlert.updateMany).not.toHaveBeenCalled();
    expect(result.acknowledgedByAdminId).toBe('adm-1');
  });

  it('guards the write on the alert still being open', async () => {
    const { service, prisma } = build();

    await service.acknowledge('sos-1', 'adm-1');

    // A conditional update, so two concurrent responders cannot both win.
    expect(prisma.sosAlert.updateMany.mock.calls[0][0].where).toEqual({
      id: 'sos-1',
      status: 'open',
    });
  });

  it('reports the response time in seconds', async () => {
    const { service, prisma } = build();
    prisma.sosAlert.findUnique.mockResolvedValue(
      anAlert({ status: 'acknowledged', acknowledgedAt: ACKED }),
    );

    const alert = await service.getForAdmin('sos-1');

    expect(alert.responseSeconds).toBe(90);
  });

  it('reports a null response time while the alert is still open', async () => {
    const { service } = build();

    const alert = await service.getForAdmin('sos-1');

    expect(alert.responseSeconds).toBe(null);
  });
});

describe('closing', () => {
  /**
   * Closing something nobody admits to having seen would record a response
   * that never happened.
   */
  it('refuses to resolve an alert nobody acknowledged', async () => {
    const { service } = build();

    await expect(
      service.resolve('sos-1', 'adm-1', {
        outcome: 'resolved',
        resolutionNotes: 'Spoke to the customer.',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('records a false alarm as a real outcome', async () => {
    const { service, prisma } = build();
    prisma.sosAlert.findUnique.mockResolvedValue(
      anAlert({ status: 'acknowledged', acknowledgedAt: ACKED }),
    );

    await service.resolve('sos-1', 'adm-1', {
      outcome: 'false_alarm',
      resolutionNotes: 'Pocket tap; customer confirmed all fine.',
    });

    expect(prisma.sosAlert.update.mock.calls[0][0].data).toMatchObject({
      status: 'false_alarm',
      resolvedByAdminId: 'adm-1',
    });
  });

  it('refuses to close an alert twice', async () => {
    const { service, prisma } = build();
    prisma.sosAlert.findUnique.mockResolvedValue(
      anAlert({ status: 'resolved', acknowledgedAt: ACKED, resolvedAt: ACKED }),
    );

    await expect(
      service.resolve('sos-1', 'adm-2', {
        outcome: 'resolved',
        resolutionNotes: 'again',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });
});

describe('what the raiser can see', () => {
  /**
   * Ops notes and the frozen snapshot are for whoever is responding, not for
   * the person who raised it — the snapshot carries the other party's phone
   * number.
   */
  it('returns status and timestamps only, never the snapshot or notes', async () => {
    const { service, prisma } = build();

    await service.listForRaiser('cus-1', 'customer');

    const select = prisma.sosAlert.findMany.mock.calls[0][0].select as Record<
      string,
      unknown
    >;
    expect(Object.keys(select).sort()).toEqual([
      'acknowledgedAt',
      'bookingId',
      'id',
      'raisedAt',
      'resolvedAt',
      'status',
    ]);
    expect(select.contextSnapshot).toBeUndefined();
    expect(select.resolutionNotes).toBeUndefined();
  });

  it('scopes a Pro to alerts they raised themselves', async () => {
    const { service, prisma } = build();

    await service.listForRaiser('pro-1', 'pro');

    expect(prisma.sosAlert.findMany.mock.calls[0][0].where).toEqual({
      proId: 'pro-1',
      raisedByType: 'pro',
    });
  });
});

describe('the admin queue order', () => {
  /**
   * The trap this guards. `orderBy: { status: 'asc' }` reads as "open first"
   * and is alphabetical — `acknowledged`, `false_alarm`, `open`, `resolved` —
   * so open alerts sorted *third*, beneath ones already closed. On a queue
   * somebody presses a panic button into, that is the one order that must not
   * happen.
   *
   * Asserted on the query, because the mock does not sort for us.
   */
  it('puts unacknowledged alerts above acknowledged ones, and both above closed', async () => {
    const { service, prisma } = build();

    await service.listForAdmin();

    expect(prisma.sosAlert.findMany.mock.calls.at(-1)![0].orderBy).toEqual([
      { resolvedAt: { sort: 'asc', nulls: 'first' } },
      { acknowledgedAt: { sort: 'asc', nulls: 'first' } },
      { raisedAt: 'asc' },
    ]);
  });

  it('still narrows to one status when asked', async () => {
    const { service, prisma } = build();

    await service.listForAdmin('open');

    expect(prisma.sosAlert.findMany.mock.calls.at(-1)![0].where).toEqual({
      status: 'open',
    });
  });
});

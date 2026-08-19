import { HttpStatus } from '@nestjs/common';
import { SupportTicketsService } from './support-tickets.service';

const NOW = new Date('2026-08-17T09:00:00.000Z');

function aTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tkt-1',
    raisedByType: 'customer',
    customerId: 'cus-1',
    proId: null,
    bookingId: 'book-1',
    category: 'billing',
    subject: 'Charged twice',
    priority: 'normal',
    status: 'open',
    isInternal: false,
    systemKey: null,
    assignedAdminId: null,
    resolutionNotes: null,
    actionTaken: null,
    escalatedAt: null,
    resolvedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function buildDeps() {
  const tx = {
    supportTicket: {
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(aTicket(args.data)),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(aTicket(args.data)),
      ),
    },
    ticketMessage: {
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'msg-1', sentAt: NOW, ...args.data }),
      ),
    },
  };

  const prisma = {
    supportTicket: {
      create: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(aTicket()),
      findUnique: jest.fn().mockResolvedValue({ ...aTicket(), messages: [] }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(aTicket(args.data)),
      ),
    },
    ticketMessage: {
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'msg-1', sentAt: NOW, ...args.data }),
      ),
    },
    booking: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ customerId: 'cus-1', proId: 'pro-1' }),
    },
    adminUser: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(
      (arg: ((client: typeof tx) => Promise<unknown>) | unknown[]) =>
        typeof arg === 'function' ? arg(tx) : Promise.all(arg),
    ),
  };

  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };

  return { prisma, tx, notifications };
}

function build() {
  const deps = buildDeps();
  const service = new SupportTicketsService(
    deps.prisma as never,
    deps.notifications as never,
  );
  return { service, ...deps };
}

// =====================================================================
// The two invisibility rules — the whole point of this module
// =====================================================================

describe('raiser visibility', () => {
  /**
   * The rule feature 13 rests on. If this predicate is ever dropped, a Pro
   * starts seeing the internal ops case opened about the job they could not
   * start — which the spec says must never happen, and which no other test in
   * this file would catch.
   */
  it('excludes internal tickets from a raiser list, in the query', async () => {
    const { service, prisma } = build();

    await service.listForRaiser('cus-1', 'customer');

    const where = prisma.supportTicket.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ isInternal: false, customerId: 'cus-1' });
  });

  it('scopes a Pro to their own tickets and nobody else’s', async () => {
    const { service, prisma } = build();

    await service.listForRaiser('pro-9', 'pro');

    expect(prisma.supportTicket.findMany.mock.calls[0][0].where).toEqual({
      isInternal: false,
      proId: 'pro-9',
    });
  });

  /**
   * Internal notes are excluded by the `where`, not filtered after loading.
   * The distinction is the test: a filter keeps working until someone adds an
   * `include`, and then quietly stops.
   */
  it('never loads internal notes on the raiser thread', async () => {
    const { service, prisma } = build();
    prisma.supportTicket.findFirst.mockResolvedValue({
      ...aTicket(),
      messages: [],
    });

    await service.getForRaiser('tkt-1', 'cus-1', 'customer');

    const args = prisma.supportTicket.findFirst.mock.calls[0][0];
    expect(args.include.messages.where).toEqual({ isInternalNote: false });
    expect(args.where).toMatchObject({
      isInternal: false,
      customerId: 'cus-1',
    });
  });

  /**
   * 404, not 403. A 403 confirms the ticket exists, which for a quietly
   * handled no-start incident is exactly the fact the Pro must not have.
   */
  it('answers 404 — not 403 — for a ticket the caller may not see', async () => {
    const { service, prisma } = build();
    prisma.supportTicket.findFirst.mockResolvedValue(null);

    await expect(
      service.getForRaiser('tkt-1', 'cus-2', 'customer'),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  /**
   * Serialise-and-search, the technique module 10 used for quiz answer keys.
   * A test that checks named fields passes forever after somebody adds an
   * `include`; this one does not.
   */
  it('leaks no internal note text anywhere in the serialised raiser response', async () => {
    const { service, prisma } = build();
    const SENTINEL = 'OPS-ONLY-SENTINEL-4417';
    // The query excluded them, so they are simply absent from the result.
    prisma.supportTicket.findFirst.mockResolvedValue({
      ...aTicket(),
      messages: [
        { id: 'msg-1', body: 'hello', isInternalNote: false, sentAt: NOW },
      ],
    });

    const response = await service.getForRaiser('tkt-1', 'cus-1', 'customer');

    expect(JSON.stringify(response)).not.toContain(SENTINEL);
  });
});

describe('internal notes', () => {
  it('refuses an internal note from a customer rather than downgrading it', async () => {
    const { service } = build();

    await expect(
      service.addRaiserMessage('tkt-1', 'cus-1', 'customer', {
        body: 'private',
        isInternalNote: true,
      }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('does not notify the raiser when an admin leaves an internal note', async () => {
    const { service, prisma, notifications } = build();
    prisma.supportTicket.findUnique.mockResolvedValue({
      ...aTicket(),
      messages: [],
    });

    await service.addAdminMessage('tkt-1', 'adm-1', {
      body: 'Called the Pro, no answer.',
      isInternalNote: true,
    });

    // Announcing that a note arrived would announce a conversation the raiser
    // cannot read.
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it('does notify the raiser on an ordinary admin reply', async () => {
    const { service, prisma, notifications } = build();
    prisma.supportTicket.findUnique.mockResolvedValue({
      ...aTicket(),
      messages: [],
    });

    await service.addAdminMessage('tkt-1', 'adm-1', { body: 'Refund issued.' });

    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
  });

  it('stays silent on an internal ticket even for a normal reply', async () => {
    const { service, prisma, notifications } = build();
    prisma.supportTicket.findUnique.mockResolvedValue({
      ...aTicket({ isInternal: true, raisedByType: 'system' }),
      messages: [],
    });

    await service.addAdminMessage('tkt-1', 'adm-1', { body: 'Noted.' });

    expect(notifications.enqueue).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Raising
// =====================================================================

describe('raising', () => {
  it('refuses a dispute with no booking to dispute', async () => {
    const { service } = build();

    await expect(
      service.createForRaiser('cus-1', 'customer', {
        category: 'dispute',
        subject: 'Work was not done',
        body: 'Nothing was cleaned',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('answers 404 for a booking the raiser does not own', async () => {
    const { service, prisma } = build();
    prisma.booking.findUnique.mockResolvedValue({
      customerId: 'someone-else',
      proId: 'pro-1',
    });

    await expect(
      service.createForRaiser('cus-1', 'customer', {
        category: 'dispute',
        subject: 'Work was not done',
        body: 'Nothing was cleaned',
        bookingId: 'book-1',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  /**
   * A system ticket is internal by construction, not by the caller
   * remembering to pass a flag. The CHECK constraint says the same thing at
   * the database, and this asserts the code does not rely on it.
   */
  it('makes every system-raised ticket internal', async () => {
    const { service, tx } = build();

    await service.raiseSystemTicket({
      systemKey: 'no_start:book-1',
      category: 'no_start',
      subject: 'No start — HB-1',
      body: 'grace expired',
    });

    expect(tx.supportTicket.create.mock.calls[0][0].data).toMatchObject({
      raisedByType: 'system',
      isInternal: true,
      systemKey: 'no_start:book-1',
    });
    expect(tx.ticketMessage.create.mock.calls[0][0].data.isInternalNote).toBe(
      true,
    );
  });

  /**
   * Every system raiser here is a sweep that runs again in minutes, so the
   * second attempt has to be a silent no-op rather than an error the caller
   * must remember to swallow.
   */
  it('returns null instead of throwing when the systemKey is already taken', async () => {
    const { service, prisma } = build();
    const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
    prisma.$transaction.mockRejectedValue(conflict);

    await expect(
      service.raiseSystemTicket({
        systemKey: 'no_start:book-1',
        category: 'no_start',
        subject: 'No start — HB-1',
        body: 'grace expired',
      }),
    ).resolves.toBeNull();
  });

  it('rethrows anything that is not a unique-constraint conflict', async () => {
    const { service, prisma } = build();
    prisma.$transaction.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.raiseSystemTicket({
        systemKey: 'no_start:book-1',
        category: 'no_start',
        subject: 'No start — HB-1',
        body: 'grace expired',
      }),
    ).rejects.toThrow('connection lost');
  });
});

// =====================================================================
// Workflow
// =====================================================================

describe('threading and workflow', () => {
  it('reopens a resolved ticket when the raiser replies', async () => {
    const { service, prisma } = build();
    prisma.supportTicket.findFirst.mockResolvedValue(
      aTicket({ status: 'resolved', resolvedAt: NOW }),
    );

    await service.addRaiserMessage('tkt-1', 'cus-1', 'customer', {
      body: 'This is still wrong.',
    });

    // Resolution is ops's opinion that the problem is over; only the raiser's
    // silence confirms it.
    expect(prisma.supportTicket.update.mock.calls[0][0].data).toEqual({
      status: 'in_progress',
      resolvedAt: null,
    });
  });

  it('refuses a reply on a closed ticket', async () => {
    const { service, prisma } = build();
    prisma.supportTicket.findFirst.mockResolvedValue(
      aTicket({ status: 'closed' }),
    );

    await expect(
      service.addRaiserMessage('tkt-1', 'cus-1', 'customer', { body: 'hi' }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('refuses to assign a ticket to an admin who cannot work it', async () => {
    const { service, prisma } = build();
    prisma.adminUser.findUnique.mockResolvedValue({
      isActive: true,
      role: { permissionCodes: ['booking.read'] },
    });

    // An assignee who cannot act on the ticket parks it rather than owning it.
    await expect(
      service.assign('tkt-1', { adminUserId: 'adm-2' }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('assigns to an admin who holds support.ticket.manage', async () => {
    const { service, prisma } = build();
    prisma.adminUser.findUnique.mockResolvedValue({
      isActive: true,
      role: { permissionCodes: ['support.ticket.manage'] },
    });

    await service.assign('tkt-1', { adminUserId: 'adm-2' });

    expect(prisma.supportTicket.update.mock.calls[0][0].data).toEqual({
      assignedAdminId: 'adm-2',
      status: 'in_progress',
    });
  });

  it('writes the escalation reason into the thread', async () => {
    const { service, tx } = build();

    await service.escalate('tkt-1', 'adm-1', { reason: 'No reply in 3 days' });

    // A status change with no explanation is a status change, not an
    // escalation.
    expect(tx.ticketMessage.create.mock.calls[0][0].data).toMatchObject({
      senderType: 'system',
      isInternalNote: true,
      body: 'Escalated: No reply in 3 days',
    });
    expect(tx.supportTicket.update.mock.calls[0][0].data.status).toBe(
      'escalated',
    );
  });

  it('keeps the first escalatedAt when a ticket is escalated twice', async () => {
    const { service, prisma, tx } = build();
    const first = new Date('2026-08-16T09:00:00.000Z');
    prisma.supportTicket.findUnique.mockResolvedValue({
      ...aTicket({ status: 'escalated', escalatedAt: first }),
      messages: [],
    });

    await service.escalate('tkt-1', 'adm-1', { reason: 'still stuck' });

    // "How long was it escalated before anyone looked" needs the first
    // timestamp, not the most recent one.
    expect(tx.supportTicket.update.mock.calls[0][0].data.escalatedAt).toBe(
      first,
    );
  });

  it('records notes and the action on resolve, and notifies the raiser', async () => {
    const { service, tx, notifications } = build();

    await service.resolve('tkt-1', 'adm-1', {
      resolutionNotes: 'Refunded in full.',
      actionTaken: 'warning',
    });

    expect(tx.supportTicket.update.mock.calls[0][0].data).toMatchObject({
      status: 'resolved',
      resolutionNotes: 'Refunded in full.',
      actionTaken: 'warning',
    });
    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not notify anyone when an internal ticket is resolved', async () => {
    const { service, prisma, tx, notifications } = build();
    prisma.supportTicket.findUnique.mockResolvedValue({
      ...aTicket({ isInternal: true, raisedByType: 'system' }),
      messages: [],
    });
    tx.supportTicket.update.mockResolvedValue(
      aTicket({ isInternal: true, status: 'resolved' }),
    );

    await service.resolve('tkt-1', 'adm-1', {
      resolutionNotes: 'Job started late.',
      actionTaken: 'none',
    });

    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it('refuses to resolve a ticket that is already closed', async () => {
    const { service, prisma } = build();
    prisma.supportTicket.findUnique.mockResolvedValue({
      ...aTicket({ status: 'closed' }),
      messages: [],
    });

    await expect(
      service.resolve('tkt-1', 'adm-1', {
        resolutionNotes: 'again',
        actionTaken: 'none',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });
});

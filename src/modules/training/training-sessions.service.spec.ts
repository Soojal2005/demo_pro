import { HttpException, HttpStatus } from '@nestjs/common';
import { TrainingSessionsService } from './training-sessions.service';

function buildDeps() {
  const prisma = {
    offlineTrainingSession: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
    },
    offlineTrainingAttendance: {
      findUnique: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  return { prisma };
}

function build(deps: ReturnType<typeof buildDeps>): TrainingSessionsService {
  return new TrainingSessionsService(deps.prisma as never);
}

/** The `where` the list built, without repeating the call in every case. */
async function whereFor(query: Record<string, unknown>) {
  const deps = buildDeps();
  await build(deps).list(query);
  const [call] = deps.prisma.offlineTrainingSession.findMany.mock.calls[0] as [
    { where: Record<string, unknown> },
  ];
  return call.where;
}

describe('TrainingSessionsService · filtering the list', () => {
  it('filters nothing when no filter is given', async () => {
    expect(await whereFor({})).toEqual({});
  });

  it('filters by status and trade', async () => {
    expect(
      await whereFor({ status: 'scheduled', categoryId: 'cat-1' }),
    ).toEqual({ status: 'scheduled', categoryId: 'cat-1' });
  });

  /**
   * Each bound stands alone. "What is coming up" has no end date, and
   * demanding one would make a caller invent a far-future instant.
   */
  it('accepts a start bound on its own', async () => {
    expect(
      await whereFor({ scheduledFrom: '2026-09-01T00:00:00.000Z' }),
    ).toEqual({
      scheduledAt: { gte: new Date('2026-09-01T00:00:00.000Z') },
    });
  });

  it('accepts an end bound on its own', async () => {
    expect(await whereFor({ scheduledTo: '2026-09-30T23:59:59.999Z' })).toEqual(
      {
        scheduledAt: { lte: new Date('2026-09-30T23:59:59.999Z') },
      },
    );
  });

  it('accepts both bounds together', async () => {
    expect(
      await whereFor({
        scheduledFrom: '2026-09-01T00:00:00.000Z',
        scheduledTo: '2026-09-30T23:59:59.999Z',
      }),
    ).toEqual({
      scheduledAt: {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-30T23:59:59.999Z'),
      },
    });
  });

  it('combines a date range with the other filters', async () => {
    expect(
      await whereFor({
        status: 'held',
        categoryId: 'cat-1',
        scheduledFrom: '2026-09-01T00:00:00.000Z',
      }),
    ).toEqual({
      status: 'held',
      categoryId: 'cat-1',
      scheduledAt: { gte: new Date('2026-09-01T00:00:00.000Z') },
    });
  });

  it('counts against the same filter it lists with', async () => {
    const deps = buildDeps();
    await build(deps).list({ status: 'scheduled' });

    const [listCall] = deps.prisma.offlineTrainingSession.findMany.mock
      .calls[0] as [{ where: unknown }];
    const [countCall] = deps.prisma.offlineTrainingSession.count.mock
      .calls[0] as [{ where: unknown }];
    expect(countCall.where).toEqual(listCall.where);
  });

  it('reports the page it was asked for', async () => {
    const deps = buildDeps();
    deps.prisma.offlineTrainingSession.count.mockResolvedValue(45);

    const result = await build(deps).list({ page: 3, limit: 20 });

    expect(result.meta).toEqual({
      page: 3,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
  });
});

describe('TrainingSessionsService · removing an enrolment', () => {
  function arrange(
    session: unknown,
    enrolment: unknown,
  ): ReturnType<typeof buildDeps> {
    const deps = buildDeps();
    deps.prisma.offlineTrainingSession.findUnique.mockResolvedValue(session);
    deps.prisma.offlineTrainingAttendance.findUnique.mockResolvedValue(
      enrolment,
    );
    return deps;
  }

  const SCHEDULED = { id: 'session-1', status: 'scheduled' };

  async function statusOf(promise: Promise<unknown>): Promise<number> {
    try {
      await promise;
    } catch (error) {
      return error instanceof HttpException ? error.getStatus() : -1;
    }
    throw new Error('Expected the call to reject, but it resolved');
  }

  it('deletes an unmarked enrolment and frees the seat', async () => {
    const deps = arrange(SCHEDULED, { markedAt: null });
    // `get` reloads the session afterwards; the shape is not what is asserted.
    const service = build(deps);
    jest.spyOn(service, 'get').mockResolvedValue({} as never);

    await service.removeEnrolment('session-1', 'pro-1');

    expect(deps.prisma.offlineTrainingAttendance.delete).toHaveBeenCalledWith({
      where: { sessionId_proId: { sessionId: 'session-1', proId: 'pro-1' } },
    });
  });

  /**
   * The row records whether somebody was in a room. Removing it would erase
   * that rather than correct the list, so a marked enrolment stays.
   */
  it('refuses once attendance has been marked', async () => {
    const deps = arrange(SCHEDULED, { markedAt: new Date() });

    const status = await statusOf(build(deps).removeEnrolment('s-1', 'pro-1'));

    expect(status).toBe(HttpStatus.CONFLICT);
    expect(deps.prisma.offlineTrainingAttendance.delete).not.toHaveBeenCalled();
  });

  it('refuses on a session that is no longer scheduled', async () => {
    const deps = arrange({ id: 's-1', status: 'held' }, { markedAt: null });

    const status = await statusOf(build(deps).removeEnrolment('s-1', 'pro-1'));

    expect(status).toBe(HttpStatus.CONFLICT);
    expect(deps.prisma.offlineTrainingAttendance.delete).not.toHaveBeenCalled();
  });

  it('404s when the Pro was never enrolled', async () => {
    const deps = arrange(SCHEDULED, null);

    const status = await statusOf(build(deps).removeEnrolment('s-1', 'pro-1'));

    expect(status).toBe(HttpStatus.NOT_FOUND);
  });

  it('404s when the session does not exist', async () => {
    const deps = arrange(null, null);

    const status = await statusOf(build(deps).removeEnrolment('s-1', 'pro-1'));

    expect(status).toBe(HttpStatus.NOT_FOUND);
  });
});

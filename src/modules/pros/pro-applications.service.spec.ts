import { ProApplicationsService } from './pro-applications.service';

function buildDeps() {
  const prisma = {
    proApplication: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    pro: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );
  const prosService = {
    generateEmployeeCode: jest.fn().mockResolvedValue('HG-00001'),
  };
  return { prisma, prosService };
}

const legalIdentity = {
  documentFullName: 'Ravi Kumar',
  documentDateOfBirth: '1994-03-12',
  documentGender: 'male' as const,
};

function buildService(
  deps: ReturnType<typeof buildDeps>,
): ProApplicationsService {
  return new ProApplicationsService(
    deps.prisma as never,
    deps.prosService as never,
  );
}

describe('ProApplicationsService', () => {
  describe('submit', () => {
    it('rejects every non-manual document source', async () => {
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.submit('pro-1', {
          ...legalIdentity,
          aadhaarSource: 'digilocker',
          panSource: 'manual',
          panUrl: 'kyc/pro-1/pan/abc',
        } as never),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 400 }),
      });
      expect(deps.prisma.proApplication.create).not.toHaveBeenCalled();
    });

    it('requires aadhaarUrl when the source is manual', async () => {
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.submit('pro-1', {
          ...legalIdentity,
          aadhaarSource: 'manual',
          panSource: 'manual',
          panUrl: 'kyc/pro-1/pan/abc',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 400 }),
      });
    });

    it('creates the application and pushes the Pro back under review', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'pro-1',
        status: 'applied',
      });
      deps.prisma.proApplication.create.mockResolvedValue({ id: 'app-1' });
      const service = buildService(deps);

      await service.submit('pro-1', {
        ...legalIdentity,
        aadhaarSource: 'manual',
        aadhaarUrl: 'kyc/pro-1/aadhaar/abc',
        panSource: 'manual',
        panUrl: 'kyc/pro-1/pan/abc',
      });

      expect(deps.prisma.$executeRaw).toHaveBeenCalled();
      expect(deps.prisma.pro.update).toHaveBeenCalledWith({
        where: { id: 'pro-1' },
        data: { status: 'under_review' },
      });
    });

    it('updates an open application instead of creating a duplicate', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'pro-1',
        status: 'under_review',
      });
      deps.prisma.proApplication.findFirst.mockResolvedValue({ id: 'app-1' });
      deps.prisma.proApplication.update.mockResolvedValue({ id: 'app-1' });
      const service = buildService(deps);

      await service.submit('pro-1', {
        ...legalIdentity,
        documentFullName: 'Ravi Kumar Corrected',
        aadhaarSource: 'manual',
        aadhaarUrl: 'kyc/pro-1/aadhaar/new',
        panSource: 'manual',
        panUrl: 'kyc/pro-1/pan/new',
      });

      expect(deps.prisma.proApplication.create).not.toHaveBeenCalled();
      expect(deps.prisma.proApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'app-1' },
          data: expect.objectContaining({
            documentFullName: 'Ravi Kumar Corrected',
            aadhaarStatus: 'pending',
            panStatus: 'pending',
            decision: null,
            rejectionReason: null,
          }),
        }),
      );
    });
  });

  describe('decide', () => {
    it('does not allow a final approved or rejected decision to be rewritten', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        decision: 'approved',
      });
      const service = buildService(deps);

      await expect(
        service.decide(
          'app-1',
          {
            decision: 'changes_requested',
            reason: 'Upload another document',
          },
          'admin-1',
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
      expect(deps.prisma.proApplication.update).not.toHaveBeenCalled();
    });

    it('refuses to approve unless both documents are verified', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'verified',
        panStatus: 'pending',
      });
      const service = buildService(deps);

      await expect(
        service.decide('app-1', { decision: 'approved' }, 'admin-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
      expect(deps.prisma.proApplication.update).not.toHaveBeenCalled();
    });

    it('requires a reason when rejecting', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'pending',
        panStatus: 'pending',
      });
      const service = buildService(deps);

      await expect(
        service.decide('app-1', { decision: 'rejected' }, 'admin-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 400 }),
      });
    });

    it('approves, sets the Pro to approved, and generates an employee code', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'verified',
        panStatus: 'verified',
        documentFullName: 'Ravi Kumar',
        documentDateOfBirth: new Date('1994-03-12'),
        documentGender: 'male',
      });
      deps.prisma.proApplication.update.mockResolvedValue({
        id: 'app-1',
        decision: 'approved',
      });
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'pro-1',
        employeeCode: null,
      });
      const service = buildService(deps);

      await service.decide('app-1', { decision: 'approved' }, 'admin-1');

      expect(deps.prosService.generateEmployeeCode).toHaveBeenCalled();
      expect(deps.prisma.pro.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pro-1' },
          data: expect.objectContaining({
            status: 'approved',
            approvedApplicationId: 'app-1',
            employeeCode: 'HG-00001',
            fullName: 'Ravi Kumar',
            dateOfBirth: new Date('1994-03-12'),
            gender: 'male',
          }),
        }),
      );
    });

    it('keeps an existing employee code rather than generating a new one', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'verified',
        panStatus: 'verified',
        documentFullName: 'Ravi Kumar',
        documentDateOfBirth: new Date('1994-03-12'),
        documentGender: 'male',
      });
      deps.prisma.proApplication.update.mockResolvedValue({
        id: 'app-1',
        decision: 'approved',
      });
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'pro-1',
        employeeCode: 'HG-00042',
      });
      const service = buildService(deps);

      await service.decide('app-1', { decision: 'approved' }, 'admin-1');

      expect(deps.prosService.generateEmployeeCode).not.toHaveBeenCalled();
      expect(deps.prisma.pro.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ employeeCode: 'HG-00042' }),
        }),
      );
    });

    it('stores a correction message and keeps the Pro under review', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'pending',
        panStatus: 'pending',
      });
      deps.prisma.proApplication.update.mockResolvedValue({
        id: 'app-1',
        decision: 'changes_requested',
      });
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'pro-1',
        employeeCode: null,
      });
      const service = buildService(deps);

      await service.decide(
        'app-1',
        {
          decision: 'changes_requested',
          reason: 'Please upload a clearer PAN image',
        },
        'admin-1',
      );

      expect(deps.prisma.proApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            decision: 'changes_requested',
            queueStatus: 'changes_requested',
            rejectionReason: 'Please upload a clearer PAN image',
          }),
        }),
      );
      expect(deps.prisma.pro.update).toHaveBeenCalledWith({
        where: { id: 'pro-1' },
        data: { status: 'under_review' },
      });
    });
  });
});

describe('ProApplicationsService.findAll · searching the queue', () => {
  async function whereFor(
    filters: Parameters<ProApplicationsService['findAll']>[0],
    allowedCityIds?: string[],
  ) {
    const deps = buildDeps();
    await buildService(deps).findAll(filters, allowedCityIds);
    const [call] = deps.prisma.proApplication.findMany.mock.calls[0] as [
      { where: Record<string, unknown>; skip: number; take: number },
    ];
    return call;
  }

  it('filters nothing when no filter is given', async () => {
    const { where } = await whereFor({});
    expect(where).toEqual({});
  });

  /**
   * The two names routinely differ — somebody signs up as "Ravi" and their
   * Aadhaar reads "Ravi Kumar Chauhan". A reviewer has whichever one the
   * conversation gave them, so both are searched.
   */
  it('matches the applicant name, their phone and the document name', async () => {
    const { where } = await whereFor({ search: 'ravi' });

    expect(where.OR).toEqual([
      { pro: { fullName: { contains: 'ravi', mode: 'insensitive' } } },
      { pro: { phone: { contains: 'ravi', mode: 'insensitive' } } },
      { documentFullName: { contains: 'ravi', mode: 'insensitive' } },
    ]);
  });

  it('ignores an empty search rather than matching everything', async () => {
    const { where } = await whereFor({ search: '' });
    expect(where.OR).toBeUndefined();
  });

  it('combines a search with the queue-status filter', async () => {
    const { where } = await whereFor({
      search: 'ravi',
      queueStatus: 'pending',
    });

    expect(where.queueStatus).toBe('pending');
    expect(where.OR).toHaveLength(3);
  });

  /** A scoped reviewer searching must not reach outside their own cities. */
  it('keeps the city scope alongside a search', async () => {
    const { where } = await whereFor({ search: 'ravi' }, ['city-1']);

    expect(where.pro).toEqual({ cityId: { in: ['city-1'] } });
    expect(where.OR).toHaveLength(3);
  });

  it('pages against the same filter it counts with', async () => {
    const deps = buildDeps();
    deps.prisma.proApplication.count.mockResolvedValue(45);

    const result = await buildService(deps).findAll({ page: 2, limit: 20 });

    const [listCall] = deps.prisma.proApplication.findMany.mock.calls[0] as [
      { where: unknown; skip: number; take: number },
    ];
    const [countCall] = deps.prisma.proApplication.count.mock.calls[0] as [
      { where: unknown },
    ];
    expect(countCall.where).toEqual(listCall.where);
    expect(listCall.skip).toBe(20);
    expect(result.meta).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
  });

  /** Longest-waiting first: a queue serves whoever has waited the most. */
  it('orders the queue oldest first', async () => {
    const deps = buildDeps();

    await buildService(deps).findAll({});

    const [call] = deps.prisma.proApplication.findMany.mock.calls[0] as [
      { orderBy: unknown },
    ];
    expect(call.orderBy).toEqual({ submittedAt: 'asc' });
  });
});

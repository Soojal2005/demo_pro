import { AdminUsersService } from './admin-users.service';

describe('AdminUsersService provisioning', () => {
  const build = () => {
    const prisma = {
      role: { findUnique: jest.fn() },
      adminUser: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const tokenService = { revokeAllSessions: jest.fn() };
    const firebase = {
      createUser: jest.fn().mockResolvedValue({ uid: 'firebase-1' }),
      deleteUser: jest.fn(),
      setDisabled: jest.fn(),
    };
    return {
      prisma,
      tokenService,
      firebase,
      service: new AdminUsersService(
        prisma as never,
        tokenService as never,
        firebase as never,
      ),
    };
  };

  const DTO = {
    phone: '+919876543210',
    fullName: 'Operations Admin',
    email: 'ops@example.com',
    password: 'ChangeMe#2026',
    roleId: 'role-1',
  };

  it('gives a new Admin a Firebase identity and stores its uid', async () => {
    const deps = build();
    deps.prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    deps.prisma.adminUser.findUnique.mockResolvedValue(null);
    deps.prisma.adminUser.create.mockResolvedValue({ id: 'admin-1' });

    await deps.service.create(DTO);

    expect(deps.firebase.createUser).toHaveBeenCalledWith({
      email: 'ops@example.com',
      password: 'ChangeMe#2026',
      displayName: 'Operations Admin',
    });
    expect(deps.prisma.adminUser.create).toHaveBeenCalledWith({
      data: {
        phone: '+919876543210',
        fullName: 'Operations Admin',
        email: 'ops@example.com',
        firebaseUid: 'firebase-1',
        roleId: 'role-1',
        cityScopeJson: [],
      },
    });
  });

  /** The password is Firebase's business; this database must never hold one. */
  it('never writes the password to Postgres', async () => {
    const deps = build();
    deps.prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    deps.prisma.adminUser.findUnique.mockResolvedValue(null);
    deps.prisma.adminUser.create.mockResolvedValue({ id: 'admin-1' });

    await deps.service.create(DTO);

    const written = JSON.stringify(
      deps.prisma.adminUser.create.mock.calls[0][0],
    );
    expect(written).not.toContain('ChangeMe#2026');
  });

  /**
   * Firebase sits outside the Postgres transaction, so a failed insert would
   * otherwise strand an account that can sign in but matches no admin row.
   */
  it('deletes the Firebase user when the row fails to insert', async () => {
    const deps = build();
    deps.prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    deps.prisma.adminUser.findUnique.mockResolvedValue(null);
    deps.prisma.adminUser.create.mockRejectedValue(new Error('insert failed'));

    await expect(deps.service.create(DTO)).rejects.toThrow('insert failed');
    expect(deps.firebase.deleteUser).toHaveBeenCalledWith('firebase-1');
  });

  it('does not touch Firebase when the role does not exist', async () => {
    const deps = build();
    deps.prisma.role.findUnique.mockResolvedValue(null);

    await expect(deps.service.create(DTO)).rejects.toThrow(
      'roleId does not exist',
    );
    expect(deps.firebase.createUser).not.toHaveBeenCalled();
  });

  it('leaves an Admin with no Firebase link alone when deactivating', async () => {
    const deps = build();
    deps.prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      firebaseUid: null,
    });
    deps.prisma.adminUser.update.mockResolvedValue({ id: 'admin-1' });

    await deps.service.update('admin-1', { isActive: false });

    expect(deps.tokenService.revokeAllSessions).toHaveBeenCalledWith(
      'admin',
      'admin-1',
    );
    expect(deps.firebase.setDisabled).not.toHaveBeenCalled();
  });

  it('keeps the Firebase identity disabled state in sync', async () => {
    const deps = build();
    deps.prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      firebaseUid: 'firebase-1',
    });
    deps.prisma.adminUser.update.mockResolvedValue({ id: 'admin-1' });

    await deps.service.update('admin-1', { isActive: true });

    expect(deps.firebase.setDisabled).toHaveBeenCalledWith('firebase-1', false);
  });
});

import { AdminUsersService } from './admin-users.service';

describe('AdminUsersService OTP provisioning', () => {
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
      createUser: jest.fn(),
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

  it('creates an OTP Admin in Postgres without provisioning Firebase', async () => {
    const deps = build();
    deps.prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    deps.prisma.adminUser.findUnique.mockResolvedValue(null);
    deps.prisma.adminUser.create.mockResolvedValue({ id: 'admin-1' });

    await deps.service.create({
      phone: '+919876543210',
      fullName: 'Operations Admin',
      email: 'ops@example.com',
      roleId: 'role-1',
    });

    expect(deps.prisma.adminUser.create).toHaveBeenCalledWith({
      data: {
        phone: '+919876543210',
        fullName: 'Operations Admin',
        email: 'ops@example.com',
        roleId: 'role-1',
        cityScopeJson: [],
      },
    });
    expect(deps.firebase.createUser).not.toHaveBeenCalled();
  });

  it('deactivates an OTP-only Admin without calling Firebase', async () => {
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

  it('keeps a legacy Firebase identity disabled state in sync', async () => {
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

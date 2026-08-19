import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RequestOtpDto } from './request-otp.dto';
import { VerifyOtpDto } from './verify-otp.dto';
import { CreateAdminUserDto } from './create-admin-user.dto';

/**
 * The console has one door: Firebase. These assert that the phone OTP flow
 * cannot be used as a second one, and that provisioning an admin still means
 * handing Firebase a credential.
 */
describe('Admin authentication boundaries', () => {
  it('refuses an Admin OTP request at validation', async () => {
    const dto = plainToInstance(RequestOtpDto, {
      phone: '9876543210',
      actorType: 'admin',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('actorType');
  });

  it('refuses an Admin OTP verification at validation', async () => {
    const dto = plainToInstance(VerifyOtpDto, {
      phone: '+919876543210',
      code: '123456',
      providerRef: 'slide-request-id',
      actorType: 'admin',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('actorType');
  });

  it('still accepts customer and pro OTP requests', async () => {
    for (const actorType of ['customer', 'pro'] as const) {
      const dto = plainToInstance(RequestOtpDto, {
        phone: '9876543210',
        actorType,
      });

      await expect(validate(dto)).resolves.toEqual([]);
      expect(dto.phone).toBe('+919876543210');
    }
  });

  it('requires a password when provisioning an Admin', async () => {
    const dto = plainToInstance(CreateAdminUserDto, {
      phone: '9876543210',
      fullName: 'Operations Admin',
      email: 'ops@example.com',
      roleId: '00000000-0000-4000-8000-000000000001',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('password');
  });

  it('accepts a provisioning request that carries one', async () => {
    const dto = plainToInstance(CreateAdminUserDto, {
      phone: '9876543210',
      fullName: 'Operations Admin',
      email: 'ops@example.com',
      password: 'ChangeMe#2026',
      roleId: '00000000-0000-4000-8000-000000000001',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.phone).toBe('+919876543210');
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RequestOtpDto } from './request-otp.dto';
import { VerifyOtpDto } from './verify-otp.dto';
import { CreateAdminUserDto } from './create-admin-user.dto';

describe('Admin OTP DTOs', () => {
  it('accepts and normalizes an Admin OTP request', async () => {
    const dto = plainToInstance(RequestOtpDto, {
      phone: '9876543210',
      actorType: 'admin',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.phone).toBe('+919876543210');
  });

  it('accepts Admin OTP verification', async () => {
    const dto = plainToInstance(VerifyOtpDto, {
      phone: '+919876543210',
      code: '123456',
      providerRef: 'slide-request-id',
      actorType: 'admin',
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('normalizes a newly provisioned Admin phone without requiring a password', async () => {
    const dto = plainToInstance(CreateAdminUserDto, {
      phone: '9876543210',
      fullName: 'Operations Admin',
      email: 'ops@example.com',
      roleId: '00000000-0000-4000-8000-000000000001',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.phone).toBe('+919876543210');
    expect(dto).not.toHaveProperty('password');
  });
});

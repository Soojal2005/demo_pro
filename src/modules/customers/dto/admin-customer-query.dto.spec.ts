import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminCustomerQueryDto } from './admin-customer-query.dto';

describe('AdminCustomerQueryDto', () => {
  it('trims phone searches after query-string plus decoding', async () => {
    const dto = plainToInstance(AdminCustomerQueryDto, {
      search: ' 919818394735',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.search).toBe('919818394735');
  });

  it('normalizes an encoded E.164 search to digits for database matching', async () => {
    const dto = plainToInstance(AdminCustomerQueryDto, {
      search: '+919818394735',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.search).toBe('919818394735');
  });

  it('preserves isBlocked=false with implicit conversion enabled', async () => {
    const dto = plainToInstance(
      AdminCustomerQueryDto,
      { isBlocked: 'false' },
      { enableImplicitConversion: true },
    );

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.isBlocked).toBe(false);
  });
});

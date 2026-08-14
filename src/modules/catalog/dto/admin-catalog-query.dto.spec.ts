import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminCatalogQueryDto } from './admin-catalog-query.dto';

describe('AdminCatalogQueryDto', () => {
  it('preserves isActive=false with implicit conversion enabled', async () => {
    const dto = plainToInstance(
      AdminCatalogQueryDto,
      { isActive: 'false' },
      { enableImplicitConversion: true },
    );

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.isActive).toBe(false);
  });
});

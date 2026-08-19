import { HttpException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { AdminUiConfigController } from './admin-ui-config.controller';
import { UiConfigService } from './ui-config.service';

describe('AdminUiConfigController city scope', () => {
  const cityId = '00000000-0000-4000-b000-000000000001';
  const otherCityId = '00000000-0000-4000-b000-000000000002';
  const actor: AuthenticatedUser = {
    id: 'admin-1',
    actorType: 'admin',
    cityScope: [cityId],
  };

  const build = () => {
    const list = jest.fn().mockResolvedValue([]);
    const service = { list } as unknown as UiConfigService;
    return { controller: new AdminUiConfigController(service), list };
  };

  it('requires a city filter for a city-scoped listing', () => {
    const { controller, list } = build();
    expect(() => controller.list({}, actor)).toThrow(HttpException);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a listing outside the actor city scope', () => {
    const { controller, list } = build();
    expect(() => controller.list({ cityId: otherCityId }, actor)).toThrow(
      HttpException,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('allows a scoped listing for the actor city', () => {
    const { controller, list } = build();
    void controller.list({ cityId }, actor);
    expect(list).toHaveBeenCalledWith({ cityId });
  });
});

import { BadRequestException } from '@nestjs/common';
import { AdminDispatchController } from './admin-dispatch.controller';
import { DispatchService } from './dispatch.service';

describe('AdminDispatchController query validation', () => {
  function build() {
    const drain = jest.fn().mockResolvedValue([]);
    const expireAcknowledgements = jest.fn().mockResolvedValue([]);
    const dispatch = {
      drain,
      expireAcknowledgements,
    } as unknown as DispatchService;
    return {
      controller: new AdminDispatchController(dispatch),
      drain,
      expireAcknowledgements,
    };
  }

  it('rejects a non-numeric drain limit', () => {
    const { controller, drain } = build();

    expect(() => controller.drain('abc')).toThrow(BadRequestException);
    expect(drain).not.toHaveBeenCalled();
  });

  it('allows a zero-item drain without consuming work', async () => {
    const { controller, drain } = build();

    await controller.drain('0');

    expect(drain).toHaveBeenCalledWith(0);
  });

  it('rejects an invalid acknowledgement-expiry timestamp', () => {
    const { controller, expireAcknowledgements } = build();

    expect(() => controller.expire('not-a-date')).toThrow(BadRequestException);
    expect(expireAcknowledgements).not.toHaveBeenCalled();
  });

  it('passes a valid acknowledgement-expiry timestamp to dispatch', async () => {
    const { controller, expireAcknowledgements } = build();

    await controller.expire('2026-08-14T05:00:00.000Z');

    expect(expireAcknowledgements).toHaveBeenCalledWith(
      new Date('2026-08-14T05:00:00.000Z'),
    );
  });
});

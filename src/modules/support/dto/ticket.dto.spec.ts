import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../../config/validation.config';
import { AdminCreateTicketDto, CreateTicketDto } from './ticket.dto';
import { RaiseSosDto } from './sos.dto';

/**
 * Rules enforced at the edge of the API rather than only in the service.
 *
 * Every case runs through `VALIDATION_PIPE_OPTIONS` — the same object
 * `main.ts` hands the global pipe — because a test proving rejection under
 * different options proves nothing about the running application.
 */
function failingFields(cls: new () => object, payload: unknown): string[] {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  return validateSync(dto, VALIDATION_PIPE_OPTIONS)
    .map((error) => error.property)
    .sort();
}

describe('CreateTicketDto — what a raiser may file', () => {
  /**
   * Feature 13's first line of defence. A raiser able to file `no_start` would
   * produce a ticket that looks system-raised and is not — and the whole
   * quiet-handling rule rests on that distinction being real.
   */
  it('rejects the no_start category outright', () => {
    expect(
      failingFields(CreateTicketDto, {
        category: 'no_start',
        subject: 'Pro never started',
        body: 'They arrived and did nothing',
      }),
    ).toEqual(['category']);
  });

  it('accepts the four self-service categories', () => {
    for (const category of ['billing', 'quality', 'dispute', 'app_issue']) {
      expect(
        failingFields(CreateTicketDto, {
          category,
          subject: 'A subject',
          body: 'A body',
        }),
      ).toEqual([]);
    }
  });

  /**
   * Priority is not the raiser's to set — every self-service ticket would be
   * urgent, which is the same as none of them being urgent. `whitelist` +
   * `forbidNonWhitelisted` turns the attempt into a 400 rather than a
   * silently dropped field.
   */
  it('rejects a priority sent by the raiser', () => {
    expect(
      failingFields(CreateTicketDto, {
        category: 'billing',
        subject: 'A subject',
        body: 'A body',
        priority: 'urgent',
      }),
    ).toEqual(['priority']);
  });

  it('rejects an isInternal flag sent by the raiser', () => {
    expect(
      failingFields(CreateTicketDto, {
        category: 'billing',
        subject: 'A subject',
        body: 'A body',
        isInternal: true,
      }),
    ).toEqual(['isInternal']);
  });
});

describe('AdminCreateTicketDto — what ops may file', () => {
  it('accepts no_start, unlike the raiser DTO', () => {
    expect(
      failingFields(AdminCreateTicketDto, {
        category: 'no_start',
        subject: 'No start',
        body: 'Opened by hand',
        bookingId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual([]);
  });

  it('rejects a priority outside the vocabulary', () => {
    expect(
      failingFields(AdminCreateTicketDto, {
        category: 'billing',
        subject: 'A subject',
        body: 'A body',
        priority: 'critical',
      }),
    ).toEqual(['priority']);
  });
});

describe('RaiseSosDto — one tap', () => {
  /**
   * The most important assertion in this file. A phone that cannot get a fix
   * must still be able to raise an alert: a missing pin degrades the response,
   * while refusing the alert defeats the feature.
   */
  it('accepts a completely empty body', () => {
    expect(failingFields(RaiseSosDto, {})).toEqual([]);
  });

  it('rejects coordinates that are not coordinates', () => {
    expect(failingFields(RaiseSosDto, { lat: 200, lng: 75.8 })).toEqual([
      'lat',
    ]);
  });

  /**
   * There is no `raisedByType` field, and there must not be — it comes from
   * the authenticated actor, or a customer could file an alert as a Pro.
   */
  it('rejects a raisedByType smuggled into the body', () => {
    expect(failingFields(RaiseSosDto, { raisedByType: 'pro' })).toEqual([
      'raisedByType',
    ]);
  });
});

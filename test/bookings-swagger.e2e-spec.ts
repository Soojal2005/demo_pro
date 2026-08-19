import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminBookingsController } from './../src/modules/bookings/admin-bookings.controller';
import { BookingCancellationService } from './../src/modules/bookings/booking-cancellation.service';
import { BookingChatService } from './../src/modules/bookings/booking-chat.service';
import { BookingLifecycleService } from './../src/modules/bookings/booking-lifecycle.service';
import { BookingRescheduleService } from './../src/modules/bookings/booking-reschedule.service';
import { BookingsController } from './../src/modules/bookings/bookings.controller';
import { BookingTrackingService } from './../src/modules/bookings/booking-tracking.service';
import { BookingsService } from './../src/modules/bookings/bookings.service';
import { ProBookingsController } from './../src/modules/bookings/pro-bookings.controller';
import { RecurringPlansService } from './../src/modules/bookings/recurring-plans.service';
import { ActorTypeGuard } from './../src/modules/identity/guards/actor-type.guard';
import { JwtAuthGuard } from './../src/modules/identity/guards/jwt-auth.guard';
import { PermissionsGuard } from './../src/modules/identity/guards/permissions.guard';

type Operation = {
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
  security?: unknown[];
};

/**
 * Module 4's half of the API_CONVENTIONS.md contract.
 *
 * Every booking route published, published as the envelope, and — for the
 * routes that can be refused on a state-machine rule — documenting the `409`
 * a client will actually receive. A lifecycle API that does not advertise its
 * conflicts forces the frontend to guess which failures are retryable.
 */
describe('Bookings Swagger contract (e2e)', () => {
  let app: NestFastifyApplication;
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const allow = { canActivate: () => true };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [
        BookingsController,
        ProBookingsController,
        AdminBookingsController,
      ],
      providers: [
        { provide: BookingsService, useValue: {} },
        { provide: BookingCancellationService, useValue: {} },
        { provide: BookingChatService, useValue: {} },
        { provide: BookingLifecycleService, useValue: {} },
        { provide: RecurringPlansService, useValue: {} },
        { provide: BookingTrackingService, useValue: {} },
        { provide: BookingRescheduleService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(PermissionsGuard)
      .useValue(allow)
      .overrideGuard(ActorTypeGuard)
      .useValue(allow)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('bookings test')
        .setVersion('1')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'access-token',
        )
        .build(),
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function operationAt(path: string, method: string): Operation {
    const operation = (
      document.paths[path] as Record<string, Operation> | undefined
    )?.[method];
    if (!operation) {
      throw new Error(
        `No documented operation for ${method.toUpperCase()} ${path}`,
      );
    }
    return operation;
  }

  const CUSTOMER_ROUTES: Array<[string, string, number]> = [
    ['/bookings', 'post', 201],
    ['/bookings', 'get', 200],
    ['/bookings/live', 'get', 200],
    ['/bookings/{id}', 'get', 200],
    ['/bookings/{id}/rebook', 'post', 201],
    ['/bookings/{id}/cancel', 'post', 200],
    ['/bookings/{id}/messages', 'get', 200],
    ['/bookings/{id}/messages', 'post', 201],
    ['/bookings/{id}/start-otp/resend', 'post', 200],
    ['/bookings/{id}/tracking', 'get', 200],
    ['/bookings/recurring-plans', 'get', 200],
    ['/bookings/recurring-plans', 'post', 201],
    ['/bookings/recurring-plans/{id}', 'patch', 200],
  ];

  const PRO_ROUTES: Array<[string, string, number]> = [
    ['/pros/me/bookings', 'get', 200],
    ['/pros/me/bookings/{id}', 'get', 200],
    ['/pros/me/bookings/{id}/en-route', 'post', 200],
    ['/pros/me/bookings/{id}/arrived', 'post', 200],
    ['/pros/me/bookings/{id}/verify-otp', 'post', 200],
    ['/pros/me/bookings/{id}/photos/upload-url', 'post', 201],
    ['/pros/me/bookings/{id}/photos', 'post', 201],
    ['/pros/me/bookings/{id}/photos', 'get', 200],
    ['/pros/me/bookings/{id}/complete', 'post', 200],
    ['/pros/me/bookings/{id}/messages', 'get', 200],
    ['/pros/me/bookings/{id}/messages', 'post', 201],
  ];

  const ADMIN_ROUTES: Array<[string, string, number]> = [
    ['/admin/bookings/{id}', 'get', 200],
    ['/admin/bookings/{id}/cancellation-window', 'get', 200],
    ['/admin/bookings/{id}/assign', 'post', 200],
    ['/admin/bookings/{id}/force-start', 'post', 200],
    ['/admin/bookings/{id}/cancel', 'post', 200],
    ['/admin/bookings/recurring-plans/run', 'post', 200],
    ['/admin/bookings/expire-unpaid', 'post', 200],
  ];

  const ALL = [...CUSTOMER_ROUTES, ...PRO_ROUTES, ...ADMIN_ROUTES];

  it.each(ALL)(
    'documents %s %s as the envelope, not the bare payload',
    (path, method, status) => {
      const schema = operationAt(path, method).responses?.[String(status)]
        ?.content?.['application/json']?.schema as
        { properties?: Record<string, unknown> } | undefined;

      if (!schema) {
        throw new Error(
          `No ${status} schema for ${method.toUpperCase()} ${path}`,
        );
      }
      const properties = Object.keys(schema.properties ?? {});

      expect(properties).toEqual(
        expect.arrayContaining([
          'success',
          'statusCode',
          'message',
          'data',
          'timestamp',
        ]),
      );
      expect(properties).not.toEqual(
        expect.arrayContaining(['id', 'bookingNumber', 'flatPrice']),
      );
    },
  );

  it.each(ALL)('requires bearer auth on %s %s', (path, method) => {
    // Every booking route is authenticated — unlike the catalogue, nothing
    // here is browsable before signing in.
    expect(operationAt(path, method).security).toEqual(
      expect.arrayContaining([{ 'access-token': [] }]),
    );
  });

  const STATEFUL_ROUTES: Array<[string, string]> = [
    ['/bookings', 'post'],
    ['/bookings/{id}/cancel', 'post'],
    ['/bookings/{id}/messages', 'post'],
    ['/pros/me/bookings/{id}/en-route', 'post'],
    ['/pros/me/bookings/{id}/arrived', 'post'],
    ['/pros/me/bookings/{id}/verify-otp', 'post'],
    ['/pros/me/bookings/{id}/complete', 'post'],
    ['/admin/bookings/{id}/assign', 'post'],
    ['/admin/bookings/{id}/force-start', 'post'],
    ['/admin/bookings/{id}/cancel', 'post'],
  ];

  it.each(STATEFUL_ROUTES)(
    'documents the 409 a state-machine rule can produce on %s %s',
    (path, method) => {
      expect(operationAt(path, method).responses).toHaveProperty('409');
    },
  );

  it('documents the 501 an online booking gets while Payments is unbuilt', () => {
    expect(operationAt('/bookings', 'post').responses).toHaveProperty('501');
  });

  it('publishes flatPrice as a string, not a number', () => {
    const schemas = document.components?.schemas as
      | Record<string, { properties?: Record<string, { type?: string }> }>
      | undefined;

    expect(schemas?.BookingDto?.properties?.flatPrice?.type).toBe('string');
  });

  it('keeps every contact detail out of the chat schema', () => {
    // Neither side may see the other's number — that is why the thread exists
    // instead of exchanging them.
    const schemas = document.components?.schemas as
      Record<string, { properties?: Record<string, unknown> }> | undefined;
    const chatFields = Object.keys(schemas?.ChatMessageDto?.properties ?? {});

    expect(chatFields).not.toEqual(
      expect.arrayContaining(['phone', 'customerPhone', 'proPhone', 'email']),
    );
  });

  it('gives a Pro no cancellation route at any depth', () => {
    // Principle 2: a Pro is a salaried employee who cannot decline work.
    const proPaths = Object.keys(document.paths).filter((path) =>
      path.startsWith('/pros/'),
    );

    for (const path of proPaths) {
      expect(path).not.toMatch(/cancel/i);
    }
  });
});

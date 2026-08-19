import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppController } from './../src/app.controller';
import { AppService } from './../src/app.service';
import {
  NoOpPaymentsService,
  PAYMENTS_PORT,
} from './../src/modules/bookings/ports/payments.port';

/**
 * Exercises the real HTTP stack (Fastify routing -> controller) without
 * booting AppModule, which now pulls in DatabaseModule and would require a
 * live AWS RDS instance just to assert on a static route.
 *
 * Once entities exist, add a separate suite that imports AppModule against a
 * throwaway test database (a `.env.test` pointing at a local or containerised
 * Postgres) so the persistence layer is covered too.
 */
describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      /*
       * `AppService` reads the payments port to answer `GET /config` — whether
       * this deployment can take an online payment. The real no-op is provided
       * rather than a stub: it is what a deployment with no gateway configured
       * actually runs, which is the state this suite asserts against.
       */
      providers: [
        AppService,
        { provide: PAYMENTS_PORT, useClass: NoOpPaymentsService },
      ],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
  });

  it('/ (GET)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe('Hello World!');
  });

  /*
   * Public and unauthenticated on purpose: the app reads this at launch,
   * before anyone has signed in, to decide whether it may offer to charge.
   */
  it('/config (GET) reports payments off with no gateway configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/config' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ paymentsEnabled: false });
  });

  afterEach(async () => {
    // Guard: if beforeEach threw, `app` is undefined and an unguarded
    // close() masks the real failure with a TypeError.
    if (app) await app.close();
  });
});

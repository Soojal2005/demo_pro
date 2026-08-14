import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { RedisService } from './../src/redis/redis.service';
import { S3Service } from './../src/storage/s3.service';

/**
 * Proves the HTTP server actually starts.
 *
 * `module-graph.e2e-spec.ts` calls `.compile()`, which resolves the dependency
 * graph and stops there — no HTTP adapter, no route registration. That is the
 * right shape for what it tests, and it means it is **blind to route
 * collisions**: two controllers declaring the same path compile perfectly and
 * then crash the process at boot with `FST_ERR_DUPLICATED_ROUTE`.
 *
 * That is exactly what happened. `GET pros/me/payouts` was declared by both
 * module 6 and module 8, every unit and e2e suite stayed green, and the
 * application could not start (CONFLICTS_AND_DECISIONS #56).
 *
 * `init()` is what registers routes with Fastify and what runs every
 * `onModuleInit`, so this suite fails the moment two routes clash — without
 * needing a database, a port, or a single request.
 */
describe('HTTP routing (e2e)', () => {
  let app: NestFastifyApplication;
  /** Every `METHOD /path` Fastify was asked to register, in order. */
  const registered: string[] = [];

  beforeAll(async () => {
    /**
     * Richer stubs than `module-graph` needs, and the difference is the point:
     * `init()` also runs every `onModuleInit`, where `.compile()` runs none. So
     * these have to satisfy what the lifecycle hooks call — a subscriber for
     * live tracking, a connect for Prisma — not merely what constructors take.
     * Nothing here issues a query or opens a socket.
     */
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: () => Promise.resolve(),
        $disconnect: () => Promise.resolve(),
        // Let AdminJob recover stale work and observe an empty queue without
        // touching infrastructure during route-registration tests.
        adminJob: {
          updateMany: () => Promise.resolve({ count: 0 }),
          findFirst: () => Promise.resolve(null),
        },
      })
      .overrideProvider(RedisService)
      .useValue({
        subscribe: () => undefined,
        publish: () => Promise.resolve(),
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        del: () => Promise.resolve(),
        // Every background worker takes this lock before doing anything.
        // False means "another instance holds it", so none of them run here.
        setIfAbsent: () => Promise.resolve(false),
      })
      .overrideProvider(S3Service)
      .useValue({})
      .compile();

    const adapter = new FastifyAdapter();

    /**
     * Collected through Fastify's own `onRoute` hook rather than by parsing
     * `printRoutes`. That output is a tree whose paths accumulate down the
     * branches, so `/:id` appears under a dozen parents and any straightforward
     * read of it reports duplicates that do not exist. The hook reports the
     * resolved url, exactly as registered.
     *
     * It must be attached before `init()`, which is when routes register.
     */
    adapter
      .getInstance()
      .addHook(
        'onRoute',
        (route: { method: string | string[]; url: string }) => {
          const methods = Array.isArray(route.method)
            ? route.method
            : [route.method];
          for (const method of methods) {
            registered.push(`${method} ${route.url}`);
          }
        },
      );

    app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('registers every route without a collision', () => {
    expect(app).toBeDefined();
  });

  /**
   * `app.init()` throwing is the real gate; this one fails with the offending
   * path **named**, which is the difference between a five-minute fix and
   * reading a Fastify error code against two hundred routes.
   *
   * `HEAD` is excluded: Fastify derives one from every `GET`, and a route
   * declared with `@All` legitimately produces the same pair twice.
   */
  it('declares no method+path pair twice', () => {
    const seen = new Set<string>();
    const duplicates = registered
      .filter((route) => !route.startsWith('HEAD '))
      .filter((route) => {
        if (seen.has(route)) return true;
        seen.add(route);
        return false;
      });

    expect(duplicates).toEqual([]);
  });

  /**
   * The specific pair that broke, kept as a named case so a future merge that
   * reintroduces it fails with an obvious message. Module 8 owns
   * `CommissionPayout`; module 6 must not also serve it.
   */
  it('serves pros/me/payouts from exactly one module', () => {
    // No `/api/v1` here: the hook sees the url as the adapter registers it,
    // and Nest applies its global prefix at a later layer.
    const payoutRoutes = registered.filter(
      (route) => route === 'GET /pros/me/payouts',
    );

    expect(payoutRoutes).toHaveLength(1);
  });

  /** Sanity: the hook actually saw the application, not an empty adapter. */
  it('registered the API the modules declare', () => {
    expect(registered.length).toBeGreaterThan(50);
    expect(registered).toContain('GET /pros/me/earnings/summary');
    expect(registered).toContain('GET /admin/ledger/verify');
  });

  /**
   * Module 10 adds a fourth controller under `pros/me`, which is exactly the
   * shape that produced #56. Named here so a collision fails with the path
   * rather than a Fastify error code.
   */
  it('serves module 10’s routes', () => {
    for (const route of [
      'GET /pros/me/training',
      'GET /pros/me/training/manifest',
      'GET /pros/me/training/sessions',
      'POST /pros/me/training/:moduleId/quiz',
      'POST /bookings/:bookingId/review',
      'POST /pros/me/bookings/:bookingId/review',
      'GET /pros/me/bookings/:bookingId/customer-advisory',
      'GET /pros/:proId/reviews',
      'POST /admin/reviews/:id/hide',
      'GET /admin/customers/:id/feedback',
      'POST /admin/training/modules',
      'POST /admin/training/sessions/:id/attendance',
    ]) {
      expect(registered).toContain(route);
    }
  });

  /**
   * `/pros/:proId/reviews` means Fastify would bind the literal `me` to
   * `:proId`. A `/pros/me/reviews` declared alongside it is not a duplicate
   * route — it is worse, a path that looks like it should work and 404s or
   * resolves to the wrong Pro depending on registration order.
   *
   * A Pro reads their own reviews at `/pros/me/ratings`, which module 6 serves.
   */
  it('does not declare /pros/me/reviews beside the public :proId route', () => {
    expect(registered).toContain('GET /pros/:proId/reviews');
    expect(registered).not.toContain('GET /pros/me/reviews');
  });
});

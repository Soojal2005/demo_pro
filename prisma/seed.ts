import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { getAuth } from 'firebase-admin/auth';
import { PrismaClient } from '../src/prisma/client';
import { buildFirebaseOptions } from '../src/config/firebase.config';
import { initFirebaseAdmin } from '../src/firebase/init-firebase-admin';
import { ALL_PERMISSION_CODES } from '../src/modules/identity/constants/permission-code';

const nodeEnv = process.env.NODE_ENV ?? 'local';
loadEnv({ path: `.env.${nodeEnv}` });
loadEnv({ path: '.env' });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Bootstrap only. All later admin accounts are provisioned by an admin API.
const SEED_ADMIN_PHONE = '+916266941709';
const SEED_ADMIN_EMAIL = 'superadmin@homingo.dev';
// Dev-only fixed password — change it via the admin console once real
// people are using this environment. Never used in production seeding.
const SEED_ADMIN_PASSWORD = 'Homingo#SuperAdmin1';

/** Idempotent: reuses the Firebase user if this seed already ran once. */
async function ensureFirebaseUser(): Promise<string> {
  const options = buildFirebaseOptions({
    NODE_ENV: nodeEnv,
    FIREBASE_SERVICE_ACCOUNT_PATH: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  });
  const auth = getAuth(initFirebaseAdmin(options.serviceAccountPath));

  try {
    const existing = await auth.getUserByEmail(SEED_ADMIN_EMAIL);
    return existing.uid;
  } catch {
    const created = await auth.createUser({
      email: SEED_ADMIN_EMAIL,
      password: SEED_ADMIN_PASSWORD,
      displayName: 'Super Admin',
    });
    return created.uid;
  }
}

async function main(): Promise<void> {
  // Catalogue-only mode is safe for local/staging refreshes: it avoids the
  // Firebase bootstrap and leaves roles/admin accounts untouched. Area
  // fixtures are excluded too: catalogue refreshes must not rewrite a live
  // city's operational coverage map.
  if (process.argv.includes('--catalog-only')) {
    await seedCatalog({ seedAreas: false });
    return;
  }

  const firebaseUid = await ensureFirebaseUser();
  const definitions = {
    ops: [
      'pro.application.review',
      'pro.moderate',
      'pro.availability.set',
      'catalog.manage',
      'catalog.city.manage',
      'booking.read',
      'booking.cancel',
      'dispatch.override',
      // A one-star spree is a roster problem before it is a content problem,
      // so ops can hide review text too — it never moves the score either way.
      'review.moderate',
      // Ops counts the cash a Pro hands back; ops cannot refund a customer.
      'payment.cash.handover.confirm',
      'admin.dashboard.read',
      'customer.read',
      'pro.read',
      'dispatch.read',
      'admin.job.read',
      'admin.bulk.execute',
      'report.export',
      'report.analytics.read',
      'platformSetting.read',
    ],
    // Support handles the cases a customer cannot self-serve: a mid-job stop
    // (window E) and the door-step OTP override.
    support: [
      'customer.moderate',
      'booking.read',
      'booking.cancel',
      'booking.force_start',
      'review.moderate',
      // Support answers "where is my money" and needs to see an order and its
      // attempts. It cannot send money back.
      'payment.read',
      'admin.dashboard.read',
      'customer.read',
      'pro.read',
      'dispatch.read',
      'admin.job.read',
      'report.export',
      'report.analytics.read',
      'platformSetting.read',
    ],
    // Commission rates are finance's call, not ops' — see US-3.10 / US-8.4.
    // Bank details and money leaving the platform are the same kind of call.
    finance: [
      'catalog.commission.set',
      'pro.bankAccount.verify',
      'payment.read',
      'payment.refund',
      'payout.read',
      'payout.approve',
      'payout.adjust',
      'ledger.read',
      'ledger.audit',
      'admin.dashboard.read',
      'pro.read',
      'admin.job.read',
      'report.export',
      'report.analytics.read',
      'platformSetting.read',
    ],
    super_admin: ALL_PERMISSION_CODES,
  } as const;

  const roles = await Promise.all(
    Object.entries(definitions).map(([name, permissionCodes]) =>
      prisma.role.upsert({
        where: { name },
        update: { permissionCodes: [...permissionCodes], isSystemRole: true },
        create: {
          name,
          description: `${name} system role`,
          permissionCodes: [...permissionCodes],
          isSystemRole: true,
        },
      }),
    ),
  );
  const superAdmin = roles.find((role) => role.name === 'super_admin')!;

  await prisma.adminUser.upsert({
    where: { phone: SEED_ADMIN_PHONE },
    update: { roleId: superAdmin.id, email: SEED_ADMIN_EMAIL, firebaseUid },
    create: {
      phone: SEED_ADMIN_PHONE,
      fullName: 'Super Admin',
      email: SEED_ADMIN_EMAIL,
      firebaseUid,
      roleId: superAdmin.id,
      isActive: true,
    },
  });

  await seedCatalog({ seedAreas: true });

  console.log(
    `Seeded four system roles and admin user (${SEED_ADMIN_PHONE}, ${SEED_ADMIN_EMAIL}).`,
  );
}

/**
 * A realistic development catalogue spanning common home-service trades, so
 * Booking, Dispatch and Commission have representative data. Ids are fixed so
 * re-running the seed is idempotent and so integration tests can hard-code
 * them.
 */
async function seedCatalog(options: { seedAreas: boolean }): Promise<void> {
  const cities = [
    {
      id: '00000000-0000-4000-9000-000000000001',
      name: 'Indore',
      state: 'Madhya Pradesh',
    },
    {
      id: '00000000-0000-4000-9000-000000000002',
      name: 'Bhopal',
      state: 'Madhya Pradesh',
    },
  ];

  for (const city of cities) {
    await prisma.city.upsert({
      where: { id: city.id },
      update: { name: city.name, state: city.state, isActive: true },
      create: { ...city, timezone: 'Asia/Kolkata', isActive: true },
    });
  }

  // parentSlug is resolved against the roots seeded in the same pass. Two
  // levels only — see CONFLICTS_AND_DECISIONS #10.
  const categories = [
    {
      id: '00000000-0000-4000-a000-000000000001',
      slug: 'home-cleaning',
      name: 'Home Cleaning',
      sortOrder: 1,
      parentSlug: null,
    },
    {
      id: '00000000-0000-4000-a000-000000000002',
      slug: 'appliance-repair',
      name: 'Appliance Repair',
      sortOrder: 2,
      parentSlug: null,
    },
    {
      id: '00000000-0000-4000-a000-000000000003',
      slug: 'plumber',
      name: 'Plumber',
      sortOrder: 3,
      parentSlug: null,
    },
    {
      id: '00000000-0000-4000-a000-000000000004',
      slug: 'electrician',
      name: 'Electrician',
      sortOrder: 4,
      parentSlug: null,
    },
    {
      id: '00000000-0000-4000-a000-000000000005',
      slug: 'carpenter',
      name: 'Carpenter',
      sortOrder: 5,
      parentSlug: null,
    },
    {
      id: '00000000-0000-4000-a000-000000000006',
      slug: 'pest-control',
      name: 'Pest Control',
      sortOrder: 6,
      parentSlug: null,
    },
    {
      id: '00000000-0000-4000-a000-000000000011',
      slug: 'deep-cleaning',
      name: 'Deep Cleaning',
      sortOrder: 1,
      parentSlug: 'home-cleaning',
    },
    {
      id: '00000000-0000-4000-a000-000000000012',
      slug: 'bathroom-cleaning',
      name: 'Bathroom Cleaning',
      sortOrder: 2,
      parentSlug: 'home-cleaning',
    },
    {
      id: '00000000-0000-4000-a000-000000000021',
      slug: 'ac-service',
      name: 'AC Service',
      sortOrder: 1,
      parentSlug: 'appliance-repair',
    },
    {
      id: '00000000-0000-4000-a000-000000000022',
      slug: 'appliance-installation',
      name: 'Appliance Installation',
      sortOrder: 2,
      parentSlug: 'appliance-repair',
    },
    {
      id: '00000000-0000-4000-a000-000000000031',
      slug: 'plumbing-repairs',
      name: 'Plumbing Repairs',
      sortOrder: 1,
      parentSlug: 'plumber',
    },
    {
      id: '00000000-0000-4000-a000-000000000041',
      slug: 'electrical-repairs',
      name: 'Electrical Repairs',
      sortOrder: 1,
      parentSlug: 'electrician',
    },
    {
      id: '00000000-0000-4000-a000-000000000051',
      slug: 'carpentry-repairs',
      name: 'Carpentry and Installation',
      sortOrder: 1,
      parentSlug: 'carpenter',
    },
    {
      id: '00000000-0000-4000-a000-000000000061',
      slug: 'pest-treatment',
      name: 'Pest Treatment',
      sortOrder: 1,
      parentSlug: 'pest-control',
    },
  ];

  const idBySlug = new Map(categories.map((c) => [c.slug, c.id]));

  for (const { parentSlug, ...category } of categories) {
    const parentCategoryId = parentSlug
      ? (idBySlug.get(parentSlug) ?? null)
      : null;
    const data = { ...category, parentCategoryId, isActive: true };
    await prisma.serviceCategory.upsert({
      where: { id: category.id },
      update: data,
      create: data,
    });
  }

  const services = [
    {
      id: '00000000-0000-4000-b000-000000000001',
      categoryId: idBySlug.get('deep-cleaning')!,
      name: 'Full Home Deep Cleaning (2 BHK)',
      description:
        'End-to-end deep clean of a 2 BHK, including kitchen and bathrooms.',
      durationMinutes: 240,
      flatPrice: '4999.00',
      commissionType: 'percent',
      commissionValue: '30.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: true,
    },
    {
      id: '00000000-0000-4000-b000-000000000002',
      categoryId: idBySlug.get('bathroom-cleaning')!,
      name: 'Bathroom Deep Clean',
      description: 'Single bathroom, descaling and sanitisation included.',
      durationMinutes: 60,
      flatPrice: '699.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: true,
    },
    {
      id: '00000000-0000-4000-b000-000000000003',
      categoryId: idBySlug.get('ac-service')!,
      name: 'Split AC Service',
      description:
        'Wet service of one split AC unit, filter and coil cleaning.',
      durationMinutes: 90,
      flatPrice: '599.00',
      commissionType: 'flat',
      commissionValue: '220.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    // Plumber
    {
      id: '00000000-0000-4000-b000-000000000011',
      categoryId: idBySlug.get('plumbing-repairs')!,
      name: 'Tap Installation and Replacement',
      description:
        'Install a new customer-supplied tap or replace an existing tap.',
      durationMinutes: 45,
      flatPrice: '249.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000012',
      categoryId: idBySlug.get('plumbing-repairs')!,
      name: 'Tap Leakage Repair',
      description:
        'Repair a leaking tap, including washer or cartridge adjustment.',
      durationMinutes: 30,
      flatPrice: '199.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000013',
      categoryId: idBySlug.get('plumbing-repairs')!,
      name: 'Pipe Fitting and Installation',
      description:
        'Fit or replace an exposed water pipe section using customer-approved material.',
      durationMinutes: 60,
      flatPrice: '399.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000014',
      categoryId: idBySlug.get('plumbing-repairs')!,
      name: 'Pipe Leakage Repair',
      description:
        'Diagnose and repair a visible leak in an accessible pipe joint or section.',
      durationMinutes: 45,
      flatPrice: '299.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000015',
      categoryId: idBySlug.get('plumbing-repairs')!,
      name: 'Wash Basin Installation',
      description:
        'Install a customer-supplied wash basin with accessible inlet and outlet connections.',
      durationMinutes: 90,
      flatPrice: '549.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000016',
      categoryId: idBySlug.get('plumbing-repairs')!,
      name: 'Toilet Flush Repair',
      description:
        'Repair a standard flush tank mechanism or accessible flush connection.',
      durationMinutes: 45,
      flatPrice: '249.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },

    // Electrician
    {
      id: '00000000-0000-4000-b000-000000000021',
      categoryId: idBySlug.get('electrical-repairs')!,
      name: 'Switch Board Replacement',
      description:
        'Replace one customer-supplied switch board and reconnect existing points safely.',
      durationMinutes: 45,
      flatPrice: '299.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000022',
      categoryId: idBySlug.get('electrical-repairs')!,
      name: 'Electrical Wire Connection and Repair',
      description:
        'Diagnose and repair an accessible loose or damaged household wire connection.',
      durationMinutes: 45,
      flatPrice: '249.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000023',
      categoryId: idBySlug.get('electrical-repairs')!,
      name: 'Ceiling Fan Installation',
      description:
        'Install one customer-supplied ceiling fan on an existing safe mounting point.',
      durationMinutes: 60,
      flatPrice: '349.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000024',
      categoryId: idBySlug.get('electrical-repairs')!,
      name: 'Ceiling Fan Repair',
      description:
        'Diagnose and repair a non-working or noisy ceiling fan where parts are accessible.',
      durationMinutes: 60,
      flatPrice: '299.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000025',
      categoryId: idBySlug.get('electrical-repairs')!,
      name: 'Light Fixture Installation',
      description:
        'Install one customer-supplied wall or ceiling light on an existing connection.',
      durationMinutes: 30,
      flatPrice: '199.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000026',
      categoryId: idBySlug.get('electrical-repairs')!,
      name: 'MCB or Fuse Replacement',
      description:
        'Replace one compatible customer-approved MCB or fuse after a safety diagnosis.',
      durationMinutes: 45,
      flatPrice: '299.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },

    // Carpenter
    {
      id: '00000000-0000-4000-b000-000000000031',
      categoryId: idBySlug.get('carpentry-repairs')!,
      name: 'Door Lock Installation',
      description:
        'Install or replace one customer-supplied standard door lock.',
      durationMinutes: 60,
      flatPrice: '349.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000032',
      categoryId: idBySlug.get('carpentry-repairs')!,
      name: 'Door Hinge Repair',
      description:
        'Realign or replace accessible hinges on one household door.',
      durationMinutes: 45,
      flatPrice: '249.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000033',
      categoryId: idBySlug.get('carpentry-repairs')!,
      name: 'Furniture Assembly',
      description:
        'Assemble one flat-pack table, chair, shelf or similar household furniture item.',
      durationMinutes: 120,
      flatPrice: '599.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000034',
      categoryId: idBySlug.get('carpentry-repairs')!,
      name: 'Curtain Rod Installation',
      description:
        'Install one customer-supplied curtain rod with standard wall brackets.',
      durationMinutes: 60,
      flatPrice: '299.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },

    // Appliance installation
    {
      id: '00000000-0000-4000-b000-000000000041',
      categoryId: idBySlug.get('appliance-installation')!,
      name: 'Geyser Installation',
      description:
        'Install a customer-supplied geyser on prepared plumbing and electrical points.',
      durationMinutes: 90,
      flatPrice: '649.00',
      commissionType: 'flat',
      commissionValue: '250.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000042',
      categoryId: idBySlug.get('appliance-installation')!,
      name: 'Washing Machine Installation',
      description:
        'Connect and level one customer-supplied washing machine at prepared utility points.',
      durationMinutes: 75,
      flatPrice: '499.00',
      commissionType: 'flat',
      commissionValue: '200.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },
    {
      id: '00000000-0000-4000-b000-000000000043',
      categoryId: idBySlug.get('appliance-installation')!,
      name: 'Water Purifier Installation',
      description:
        'Install a customer-supplied water purifier at prepared inlet and power points.',
      durationMinutes: 90,
      flatPrice: '599.00',
      commissionType: 'flat',
      commissionValue: '225.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },

    // Pest control
    {
      id: '00000000-0000-4000-b000-000000000051',
      categoryId: idBySlug.get('pest-treatment')!,
      name: 'General Pest Control',
      description:
        'General crawling-insect treatment for a standard two-bedroom home.',
      durationMinutes: 120,
      flatPrice: '899.00',
      commissionType: 'percent',
      commissionValue: '30.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: true,
    },
    {
      id: '00000000-0000-4000-b000-000000000052',
      categoryId: idBySlug.get('pest-treatment')!,
      name: 'Cockroach Control Treatment',
      description:
        'Targeted cockroach treatment for kitchen, bathroom and common hiding areas.',
      durationMinutes: 90,
      flatPrice: '799.00',
      commissionType: 'percent',
      commissionValue: '30.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: true,
    },
    {
      id: '00000000-0000-4000-b000-000000000053',
      categoryId: idBySlug.get('pest-treatment')!,
      name: 'Termite Inspection and Treatment',
      description:
        'Inspect accessible termite activity and treat the agreed affected area.',
      durationMinutes: 180,
      flatPrice: '1499.00',
      commissionType: 'percent',
      commissionValue: '30.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: false,
    },
  ];

  for (const service of services) {
    const data = { ...service, isActive: true };
    await prisma.service.upsert({
      where: { id: service.id },
      update: data,
      create: data,
    });
  }

  if (options.seedAreas) {
    await seedIndoreAreas(services.map((service) => service.id));
  }

  console.log(
    `Seeded ${cities.length} cities, ${categories.length} categories and ${services.length} services.`,
  );
}

/**
 * Four Indore areas as a **tiled 2×2 block of ~6 km cells**.
 *
 * Note what these are not: they do not overlap, and they do not leave gaps
 * between them. Each cell's northern edge is the next cell's southern edge —
 * the *same number*, not a near-miss — which is exactly what the half-open
 * bounds rely on. A pin on the boundary resolves to precisely one cell.
 *
 * The names are real neighbourhoods so the fixtures read sensibly, but the
 * geometry is a grid, which is what the generator produces and what ops then
 * renames. See CONFLICTS_AND_DECISIONS #42.
 *
 * Every service is on in every area **except** Rau, which is deliberately left
 * without the deep clean — so there is a working example of
 * `SERVICE_NOT_AVAILABLE_IN_AREA` to develop and demo against rather than a
 * uniformly-available map that makes the whole feature look inert.
 */
async function seedIndoreAreas(serviceIds: string[]): Promise<void> {
  const INDORE = '00000000-0000-4000-9000-000000000001';
  const DEEP_CLEAN = '00000000-0000-4000-b000-000000000001';

  // A 2×2 grid of ~6 km cells around central Indore. Shared edges are written
  // once as constants so the tiling is exact rather than approximately right.
  const LAT_S = 22.66;
  const LAT_MID = 22.714; // 6 km north of LAT_S
  const LAT_N = 22.768;
  const LNG_W = 75.8;
  const LNG_MID = 75.858; // ~6 km east of LNG_W at this latitude
  const LNG_E = 75.916;

  const areas = [
    {
      id: '00000000-0000-4000-c000-000000000001',
      name: 'Vijay Nagar',
      minLat: LAT_MID,
      maxLat: LAT_N,
      minLng: LNG_MID,
      maxLng: LNG_E,
    },
    {
      id: '00000000-0000-4000-c000-000000000002',
      name: 'Rajwada',
      minLat: LAT_MID,
      maxLat: LAT_N,
      minLng: LNG_W,
      maxLng: LNG_MID,
    },
    {
      id: '00000000-0000-4000-c000-000000000003',
      name: 'Palasia',
      minLat: LAT_S,
      maxLat: LAT_MID,
      minLng: LNG_MID,
      maxLng: LNG_E,
    },
    {
      id: '00000000-0000-4000-c000-000000000004',
      name: 'Rau',
      minLat: LAT_S,
      maxLat: LAT_MID,
      minLng: LNG_W,
      maxLng: LNG_MID,
    },
  ];

  for (const area of areas) {
    const data = { ...area, cityId: INDORE, isActive: true };
    await prisma.area.upsert({
      where: { id: area.id },
      update: data,
      create: data,
    });

    for (const serviceId of serviceIds) {
      const isActive = !(area.name === 'Rau' && serviceId === DEEP_CLEAN);
      await prisma.areaService.upsert({
        where: { areaId_serviceId: { areaId: area.id, serviceId } },
        update: { isActive },
        create: { areaId: area.id, serviceId, isActive },
      });
    }
  }

  console.log(
    `Seeded ${areas.length} tiled Indore areas (deep clean off in Rau, for a working unavailable case).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());

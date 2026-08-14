require('dotenv').config({ path: '.env.local', quiet: true });
const { Client } = require('pg');

async function main() {
  const [mode, id] = process.argv.slice(2);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (mode === 'inspect-leak') {
      const services = await client.query(
        'SELECT id, name FROM services WHERE "categoryId" = $1',
        [id],
      );
      const addresses = await client.query(
        "SELECT id, \"customerId\", landmark FROM customer_addresses WHERE landmark LIKE 'Updated by AWS cURL test%' ORDER BY \"createdAt\" DESC LIMIT 5",
      );
      console.log(JSON.stringify({ services: services.rows, addresses: addresses.rows }));
      return;
    }
    const tables = {
      service: 'services',
      category: 'service_categories',
      city: 'cities',
      address: 'customer_addresses',
      customer: 'customers',
    };
    const table = tables[mode];
    if (!table || !/^[0-9a-f-]{36}$/i.test(id ?? '')) {
      throw new Error('Usage: cleanup-exact.cjs <service|category|city|address|customer> <uuid>');
    }
    const result = await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    console.log(JSON.stringify({ table, id, deleted: result.rowCount }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import pkg from 'pg';
const { Pool } = pkg;
import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const redisUrl = process.env.REDIS_URL || null;

console.log('DB Url:', databaseUrl);
console.log('Redis Url:', redisUrl);

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

const redis = redisUrl ? new Redis(redisUrl) : null;

async function run() {
  try {
    // 1. Check current time on PG
    const timeRes = await pool.query("SELECT NOW() AT TIME ZONE 'UTC' as utc_now, NOW() as local_now");
    console.log('UTC Now:', timeRes.rows[0].utc_now);
    console.log('Local Now:', timeRes.rows[0].local_now);

    // 2. Check if table users exists
    const checkTable = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name = 'users'
      )
    `);
    console.log('Table users exists:', checkTable.rows[0].exists);

    if (!checkTable.rows[0].exists) {
      console.log('Table users does not exist!');
      return;
    }

    // 3. Check if there are users with premium_until
    const usersRes = await pool.query(`
      SELECT id, first_name, username, premium_until, notified_exp_3d, notified_exp_1d, notified_exp_0d, active, premium_limit
      FROM users
      WHERE premium_until IS NOT NULL
      ORDER BY premium_until ASC
    `);
    console.log(`Total users with premium_until: ${usersRes.rows.length}`);
    console.log('First 10 users with premium_until:');
    usersRes.rows.slice(0, 10).forEach(u => {
      console.log(`- ID: ${u.id}, Name: ${u.first_name}, Limit: ${u.premium_limit}, Exp: ${u.premium_until}, Active: ${u.active}, 3d: ${u.notified_exp_3d}, 1d: ${u.notified_exp_1d}, 0d: ${u.notified_exp_0d}`);
    });

    // 4. Check what findUsersExpiringIn returns for 3, 1, 0
    for (const days of [0, 1, 3]) {
      const sql = `
        SELECT id, first_name, premium_until
        FROM users
        WHERE active = TRUE
          AND premium_limit <> COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3)
          AND premium_until IS NOT NULL
          AND premium_until >= date_trunc('day', (NOW() AT TIME ZONE 'UTC')) + make_interval(days => $1::int)
          AND premium_until <  date_trunc('day', (NOW() AT TIME ZONE 'UTC')) + make_interval(days => ($1::int + 1))
      `;
      const { rows } = await pool.query(sql, [days]);
      console.log(`Users expiring in ${days} days (without flag filter): ${rows.length}`);
      rows.forEach(r => {
        console.log(`  - User: ${r.first_name} (${r.id}), Exp: ${r.premium_until}`);
      });
    }

    // 5. Check Redis key
    if (redis) {
      const lastRun = await redis.get('notifier:last_run');
      console.log('Redis key notifier:last_run:', lastRun);
    } else {
      console.log('Redis is not configured');
    }
  } catch (e) {
    console.error('Error:', e);
  } finally {
    await pool.end();
    if (redis) redis.disconnect();
  }
}

run();

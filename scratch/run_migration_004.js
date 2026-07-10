import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error('❌ Error: DATABASE_URL is not set in your environment variables.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const migrationPath = path.join(process.cwd(), 'migrations', '004_karaoke_testers.sql');
  console.log(`📖 Reading migration from: ${migrationPath}`);
  
  if (!fs.existsSync(migrationPath)) {
    console.error('❌ Error: Migration file not found!');
    process.exit(1);
  }

  const sql = fs.readFileSync(migrationPath, 'utf8');
  
  console.log('⚡ Running migration SQL...');
  try {
    await pool.query(sql);
    console.log('✅ Migration executed successfully!');
  } catch (err) {
    console.error('❌ Error executing migration:', err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();

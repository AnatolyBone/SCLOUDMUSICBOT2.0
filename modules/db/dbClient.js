import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { DATABASE_URL, SUPABASE_URL, SUPABASE_KEY } from '../config/env.js';

export const pool = new Pool({
  connectionString: DATABASE_URL,
});

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

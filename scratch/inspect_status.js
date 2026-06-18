import 'dotenv/config';
import { pool } from '../db.js';

async function test() {
  try {
    const settingsRes = await pool.query('SELECT * FROM app_settings');
    console.log('--- APP SETTINGS ---');
    console.log(settingsRes.rows);

    const usersRes = await pool.query(
      'SELECT id, username, first_name, downloads_today, premium_limit FROM users WHERE id IN ($1, $2)',
      ['5865444965', '1251355974']
    );
    console.log('--- USERS IN LOG ---');
    console.log(usersRes.rows);

  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

test();

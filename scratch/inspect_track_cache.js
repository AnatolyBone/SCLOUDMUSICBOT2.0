import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config({ path: 'D:/projects/SCLOUDMUSICBOT2.0-main/.env' });

const databaseUrl = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query("SELECT * FROM track_cache WHERE url LIKE '%2151522561%' OR url LIKE '%2216330357%' OR url LIKE '%1385528170%'");
    console.log(`Found tracks matching query: ${res.rows.length}`);
    res.rows.forEach(row => {
      console.log('--- Row ---');
      console.log('url:', row.url);
      console.log('file_id:', row.file_id);
      console.log('title:', row.title);
      console.log('artist:', row.artist);
      console.log('duration:', row.duration);
      console.log('source:', row.source);
    });

    // Also let's check one track by fuzzy title search to see how it's saved
    const res2 = await pool.query("SELECT * FROM track_cache WHERE title ILIKE '%APT%' OR title ILIKE '%Bruno Mars%' LIMIT 5");
    console.log(`\nFound tracks matching 'Bruno Mars' or 'APT': ${res2.rows.length}`);
    res2.rows.forEach(row => {
      console.log('--- Row ---');
      console.log('url:', row.url);
      console.log('file_id:', row.file_id);
      console.log('title:', row.title);
      console.log('artist:', row.artist);
      console.log('duration:', row.duration);
      console.log('source:', row.source);
    });

  } catch (e) {
    console.error('Error:', e);
  } finally {
    await pool.end();
  }
}

run();

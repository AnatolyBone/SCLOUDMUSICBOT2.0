const TELEGRAM_ID = /^\d{1,20}$/;
const USERNAME = /^[A-Za-z0-9_]{5,32}$/;

export function normalizeUserIdentifier(value) {
  const raw = String(value ?? '').trim();
  if (TELEGRAM_ID.test(raw)) return { type: 'id', value: raw };
  const username = raw.replace(/^@/, '');
  if (USERNAME.test(username)) return { type: 'username', value: username };
  throw new Error('Введите корректный Telegram ID или username.');
}

export async function resolveUserIdentifier(value, query) {
  const identifier = normalizeUserIdentifier(value);
  const sql = identifier.type === 'id'
    ? 'SELECT id, username FROM public.users WHERE id = $1 LIMIT 1'
    : 'SELECT id, username FROM public.users WHERE LOWER(username) = LOWER($1) ORDER BY last_active DESC NULLS LAST, id LIMIT 1';
  const result = await query(sql, [identifier.value]);
  return result.rows[0] || null;
}

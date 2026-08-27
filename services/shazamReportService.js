import { SHAZAM_TELEMETRY_AVAILABLE_FROM, calculateShazamConversions } from './shazamAnalyticsService.js';

const EVENTS = [
  'shazam_request', 'shazam_recognized', 'shazam_not_recognized',
  'shazam_track_found', 'shazam_track_not_found', 'shazam_delivered'
];

function emptySummary() {
  return { users: 0, requests: 0, recognized: 0, not_recognized: 0, not_found: 0, found: 0, delivered: 0 };
}

function dateRange(startDate, endDate) {
  const rows = [];
  for (let cursor = new Date(`${startDate}T00:00:00Z`), end = new Date(`${endDate}T00:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    rows.push(cursor.toISOString().slice(0, 10));
  }
  return rows;
}

export async function getShazamAnalyticsData({ query, startDate, endDate, excludedUserIds = [] }) {
  const available = endDate >= SHAZAM_TELEMETRY_AVAILABLE_FROM;
  const effectiveStart = startDate > SHAZAM_TELEMETRY_AVAILABLE_FROM ? startDate : SHAZAM_TELEMETRY_AVAILABLE_FROM;
  const base = {
    availableFrom: SHAZAM_TELEMETRY_AVAILABLE_FROM,
    available,
    effectiveStart: available ? effectiveStart : null,
    summary: available ? emptySummary() : null,
    conversions: null,
    bySource: [],
    reasons: [],
    daily: []
  };
  if (!available) {
    return { ...base, daily: dateRange(startDate, endDate).map(day => ({ day, available: false })) };
  }

  const start = `${effectiveStart}T00:00:00+03:00`;
  const end = `${endDate}T23:59:59.999+03:00`;
  const params = [start, end, excludedUserIds, EVENTS];
  const [summaryRes, sourceRes, reasonRes, dailyRes] = await Promise.all([
    query(`SELECT COUNT(DISTINCT user_id)::int AS users,
      COUNT(*) FILTER (WHERE event_name='shazam_request')::int AS requests,
      COUNT(*) FILTER (WHERE event_name='shazam_recognized')::int AS recognized,
      COUNT(*) FILTER (WHERE event_name='shazam_not_recognized')::int AS not_recognized,
      COUNT(*) FILTER (WHERE event_name='shazam_track_not_found')::int AS not_found,
      COUNT(*) FILTER (WHERE event_name='shazam_track_found')::int AS found,
      COUNT(*) FILTER (WHERE event_name='shazam_delivered')::int AS delivered
      FROM analytics_events WHERE created_at BETWEEN $1 AND $2 AND event_name=ANY($4::text[])
      AND user_id IS NOT NULL AND NOT (user_id=ANY($3::bigint[]))`, params),
    query(`SELECT COALESCE(event_data->>'source','other') AS source,
      COUNT(DISTINCT user_id)::int AS users,
      COUNT(*) FILTER (WHERE event_name='shazam_request')::int AS requests,
      COUNT(*) FILTER (WHERE event_name='shazam_recognized')::int AS recognized
      FROM analytics_events WHERE created_at BETWEEN $1 AND $2 AND event_name=ANY($4::text[])
      AND user_id IS NOT NULL AND NOT (user_id=ANY($3::bigint[])) GROUP BY 1 ORDER BY 1`, params),
    query(`SELECT COALESCE(event_data->>'reason','other') AS reason, COUNT(*)::int AS count
      FROM analytics_events WHERE created_at BETWEEN $1 AND $2 AND event_name='shazam_not_recognized'
      AND user_id IS NOT NULL AND NOT (user_id=ANY($3::bigint[])) GROUP BY 1 ORDER BY count DESC`, params.slice(0, 3)),
    query(`SELECT (created_at AT TIME ZONE 'Europe/Moscow')::date::text AS day,
      COUNT(DISTINCT user_id)::int AS users,
      COUNT(*) FILTER (WHERE event_name='shazam_request')::int AS requests,
      COUNT(*) FILTER (WHERE event_name='shazam_recognized')::int AS recognized,
      COUNT(*) FILTER (WHERE event_name='shazam_track_found')::int AS found,
      COUNT(*) FILTER (WHERE event_name='shazam_delivered')::int AS delivered
      FROM analytics_events WHERE created_at BETWEEN $1 AND $2 AND event_name=ANY($4::text[])
      AND user_id IS NOT NULL AND NOT (user_id=ANY($3::bigint[])) GROUP BY 1 ORDER BY 1`, params)
  ]);
  const summary = { ...emptySummary(), ...(summaryRes.rows[0] || {}) };
  const failures = Number(summary.not_recognized || 0);
  return {
    ...base,
    summary,
    conversions: calculateShazamConversions(summary),
    bySource: sourceRes.rows.map(row => ({
      ...row,
      success_rate: Number(row.requests) > 0 ? Number(row.recognized) / Number(row.requests) : null
    })),
    reasons: reasonRes.rows.map(row => ({
      ...row,
      share: failures > 0 ? Number(row.count) / failures : null
    })),
    daily: (() => {
      const values = new Map(dailyRes.rows.map(row => [row.day, row]));
      return dateRange(startDate, endDate).map(day => day < SHAZAM_TELEMETRY_AVAILABLE_FROM
        ? { day, available: false }
        : { day, available: true, users: 0, requests: 0, recognized: 0, found: 0, delivered: 0, ...(values.get(day) || {}) });
    })()
  };
}

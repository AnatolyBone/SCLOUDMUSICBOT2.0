export const SHAZAM_TELEMETRY_AVAILABLE_FROM = '2026-08-27';

const EVENT_NAMES = new Set([
  'shazam_request',
  'shazam_recognized',
  'shazam_not_recognized',
  'shazam_track_found',
  'shazam_track_not_found',
  'shazam_delivered'
]);

const SOURCE_CODES = Object.freeze({ voice: 'v', video_note: 'n' });
const CODE_SOURCES = Object.freeze({ v: 'voice', n: 'video_note' });

export function getShazamSource(message = {}) {
  if (message.voice) return 'voice';
  if (message.video_note) return 'video_note';
  return null;
}

export function normalizeShazamText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function buildShazamDeduplicationKey(eventName, updateId) {
  if (!EVENT_NAMES.has(eventName) || updateId === undefined || updateId === null) return null;
  return `${eventName}:${String(updateId).slice(0, 100)}`;
}

export function buildShazamEventData(ctx, extra = {}) {
  const message = ctx?.message || {};
  const source = getShazamSource(message);
  const media = source ? message[source] : null;
  return {
    source,
    ...(Number.isFinite(Number(media?.duration)) ? { duration_sec: Number(media.duration) } : {}),
    ...(Number.isFinite(Number(media?.file_size)) ? { file_size: Number(media.file_size) } : {}),
    ...extra
  };
}

export async function trackShazamEvent(ctx, eventName, extra = {}, tracker = null) {
  const userId = ctx?.from?.id;
  const updateId = ctx?.update?.update_id;
  if (!userId || !EVENT_NAMES.has(eventName)) return false;
  try {
    const analytics = tracker || (await import('./analyticsService.js')).analyticsService;
    await analytics.trackEventSafe(userId, eventName, 'shazam', {
      ...buildShazamEventData(ctx, extra),
      event_source: 'shazam',
      deduplication_key: buildShazamDeduplicationKey(eventName, updateId)
    }, ctx);
    return true;
  } catch (error) {
    console.warn(`[Shazam Analytics] ${eventName} was not recorded:`, error.message);
    return false;
  }
}

export function tagShazamInlineResults(results, { updateId, source }) {
  const code = SOURCE_CODES[source];
  if (!code || updateId === undefined || updateId === null) return results;
  return results.map((result, index) => result?.audio_file_id ? ({
    ...result,
    id: `shz:${code}:${updateId}:${index}`
  }) : result);
}

export function parseShazamInlineResultId(resultId) {
  const match = /^shz:([vn]):(-?\d+):\d+$/.exec(String(resultId || ''));
  if (!match) return null;
  return { source: CODE_SOURCES[match[1]], updateId: match[2] };
}

export function calculateShazamConversions(summary = {}) {
  const ratio = (numerator, denominator) => Number(denominator) > 0 ? Number(numerator || 0) / Number(denominator) : null;
  return {
    request_to_recognized: ratio(summary.recognized, summary.requests),
    recognized_to_found: ratio(summary.found, summary.recognized),
    found_to_delivered: ratio(summary.delivered, summary.found),
    request_to_delivered: ratio(summary.delivered, summary.requests)
  };
}

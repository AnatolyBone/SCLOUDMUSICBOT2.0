const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const STARTUP_BACKFILL_MAX_DAYS = 90;
export const MANUAL_BACKFILL_MAX_DAYS = 366;

export function parseAnalyticsDay(value, label = 'date') {
  const text = String(value || '');
  if (!DAY_RE.test(text)) throw new Error(`${label} must use YYYY-MM-DD format`);
  const timestamp = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== text) {
    throw new Error(`${label} is not a valid calendar date`);
  }
  return text;
}

export function shiftAnalyticsDay(day, offset) {
  const validDay = parseAnalyticsDay(day);
  return new Date(Date.parse(`${validDay}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

export function analyticsDayRange(startDate, endDate, maxDays = MANUAL_BACKFILL_MAX_DAYS) {
  const start = parseAnalyticsDay(startDate, 'startDate');
  const end = parseAnalyticsDay(endDate, 'endDate');
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error('maxDays must be a positive integer');
  if (start > end) throw new Error('startDate must not be after endDate');

  const totalDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  if (totalDays > maxDays) throw new Error(`Analytics backfill range must not exceed ${maxDays} days (requested ${totalDays})`);

  return Array.from({ length: totalDays }, (_, index) => shiftAnalyticsDay(start, index));
}

export function planStartupAnalyticsBackfill(maxDay, yesterday, maxDays = STARTUP_BACKFILL_MAX_DAYS) {
  const endDate = parseAnalyticsDay(yesterday, 'yesterday');
  if (!maxDay) {
    return { status: 'empty', maxDayBefore: null, startDate: null, endDate, totalDays: 0, dates: [] };
  }

  const maxDayBefore = parseAnalyticsDay(maxDay, 'MAX(day)');
  const startDate = shiftAnalyticsDay(maxDayBefore, 1);
  if (startDate > endDate) {
    return { status: 'current', maxDayBefore, startDate: null, endDate, totalDays: 0, dates: [] };
  }

  try {
    const dates = analyticsDayRange(startDate, endDate, maxDays);
    return { status: 'ready', maxDayBefore, startDate, endDate, totalDays: dates.length, dates };
  } catch (error) {
    const totalDays = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS) + 1;
    return { status: 'limit_exceeded', maxDayBefore, startDate, endDate, totalDays, maxDays, dates: [], error: error.message };
  }
}

export function selectAnalyticsBackfillCandidates(days, skipExisting = true) {
  if (!Array.isArray(days)) throw new Error('days must be an array');
  return skipExisting ? days.filter(day => !day.aggregated) : [...days];
}

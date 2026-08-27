const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveReportPeriod(requestedStartDate, requestedEndDate, availableEndDate) {
  if (!DAY_RE.test(requestedStartDate) || !DAY_RE.test(requestedEndDate)) throw new Error('Invalid report date');
  const actualEndDate = DAY_RE.test(availableEndDate || '') && availableEndDate < requestedEndDate
    ? availableEndDate
    : requestedEndDate;
  if (actualEndDate < requestedStartDate) throw new Error('No aggregated data in requested period');
  const isTruncated = actualEndDate !== requestedEndDate;
  return {
    requestedStartDate,
    requestedEndDate,
    startDate: requestedStartDate,
    endDate: actualEndDate,
    isTruncated,
    truncationReason: isTruncated ? 'analytics_daily_missing_after_end' : null,
    analyticsDailyMissingAfter: isTruncated ? actualEndDate : null
  };
}

export function markActivityAvailability(rows, completeFrom) {
  return rows.map(row => {
    const available = DAY_RE.test(completeFrom || '') && row.day >= completeFrom;
    return { ...row, dau: available ? row.dau : null, wau: available ? row.wau : null, mau: available ? row.mau : null, activity_available: available };
  });
}

export function averageAvailable(rows, key) {
  const values = rows.map(row => row[key]).filter(value => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

export function comparableHalfTrend(rows, key) {
  const values = rows.map(row => row[key]).filter(value => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
  if (values.length < 4) return null;
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half);
  const second = values.slice(values.length - half);
  const previous = first.reduce((sum, value) => sum + value, 0) / first.length;
  const current = second.reduce((sum, value) => sum + value, 0) / second.length;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

export function previousDayPercentDelta(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  const currentNumber = Number(current);
  const previousNumber = Number(previous);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(previousNumber) || previousNumber === 0) return null;
  return currentNumber / previousNumber - 1;
}

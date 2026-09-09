function finiteMetric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

export function addPromoRates(row = {}) {
  const impressions = finiteMetric(row.impressions);
  const uniqueImpressions = finiteMetric(row.unique_impressions);
  const clicks = finiteMetric(row.clicks_total ?? row.clicks);
  const uniqueClicks = finiteMetric(row.unique_clicks);

  return {
    ...row,
    impressions,
    unique_impressions: uniqueImpressions,
    clicks,
    clicks_total: clicks,
    unique_clicks: uniqueClicks,
    ctr: impressions > 0 ? (100 * clicks) / impressions : 0,
    unique_ctr: uniqueImpressions > 0 ? (100 * uniqueClicks) / uniqueImpressions : 0,
    frequency: uniqueImpressions > 0 ? impressions / uniqueImpressions : 0
  };
}

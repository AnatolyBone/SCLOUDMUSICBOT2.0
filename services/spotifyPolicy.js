import { getActiveTariffCode } from './downloadLimitCore.js';

export function hasSpotifyUnlimitedAccess(user, userId, adminId) {
  return Number(userId) === Number(adminId) || getActiveTariffCode(user) === 'unlimited';
}

export function getSpotifyQualityForUser(user, requestedQuality, userId, adminId) {
  if (!hasSpotifyUnlimitedAccess(user, userId, adminId)) return 'low';
  return ['low', 'medium', 'high'].includes(requestedQuality) ? requestedQuality : 'low';
}

export function buildSpotifyCacheKey(spotifyTrackId, quality) {
  if (!spotifyTrackId || !['low', 'medium', 'high'].includes(quality)) return null;
  return `spotify:${spotifyTrackId}:${quality}`;
}

export function isSpotifyCacheRowMatch(row, spotifyTrackId, quality) {
  return Boolean(row)
    && row.source === 'spotify'
    && row.spotify_id === spotifyTrackId
    && row.quality === quality;
}

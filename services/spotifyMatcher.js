function normalizeMatchText(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokenCoverage(expected, actual) {
  const expectedTokens = normalizeMatchText(expected).split(' ').filter(token => token.length > 1);
  if (!expectedTokens.length) return 0;
  const actualText = ` ${normalizeMatchText(actual)} `;
  return expectedTokens.filter(token => actualText.includes(` ${token} `)).length / expectedTokens.length;
}

export function scoreSpotifyYouTubeCandidate(track, candidate) {
  const expectedDuration = Number(track?.duration);
  const candidateDuration = Number(candidate?.duration);
  if (!Number.isFinite(expectedDuration) || !Number.isFinite(candidateDuration)) return -Infinity;
  const durationDelta = Math.abs(expectedDuration - candidateDuration);
  const durationTolerance = Math.max(8, Math.round(expectedDuration * 0.08));
  if (durationDelta > durationTolerance) return -Infinity;
  const candidateTitle = candidate?.title || '';
  const candidateArtist = candidate?.artist || candidate?.uploader || candidate?.channel || '';
  const combined = `${candidateTitle} ${candidateArtist}`;
  const titleCoverage = tokenCoverage(track?.title, candidateTitle);
  const artistCoverage = tokenCoverage(track?.artist || track?.uploader, combined);
  if (titleCoverage < 0.6 || artistCoverage <= 0) return -Infinity;
  const expected = normalizeMatchText(`${track?.title} ${track?.artist || track?.uploader}`);
  const suspicious = ['karaoke', 'cover', 'tribute', 'reaction', 'slowed', 'sped up', 'nightcore'];
  if (suspicious.some(term => normalizeMatchText(combined).includes(term) && !expected.includes(term))) return -Infinity;
  return titleCoverage * 60 + artistCoverage * 30 + (1 - durationDelta / durationTolerance) * 10;
}

export function selectSpotifyYouTubeCandidate(track, candidates = []) {
  return candidates
    .map(candidate => ({ candidate, score: scoreSpotifyYouTubeCandidate(track, candidate) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)[0]?.candidate || null;
}

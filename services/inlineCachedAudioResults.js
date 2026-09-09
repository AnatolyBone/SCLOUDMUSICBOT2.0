import crypto from 'crypto';

function hasMeaningfulValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized !== '' && !['null', 'undefined'].includes(normalized.toLowerCase());
}

export function isUsableInlineCachedTrack(track) {
  return hasMeaningfulValue(track?.file_id) && hasMeaningfulValue(track?.title);
}

export function formatInlineCachedAudioResults(tracks, options = {}) {
  const botUsername = options.botUsername || 'SCloudMusicBot';
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const caption = `Скачано с помощью @${botUsername}`;

  return (tracks || [])
    .filter(isUsableInlineCachedTrack)
    .map(track => ({
      type: 'audio',
      id: `cache_${randomBytes(8).toString('hex')}`,
      audio_file_id: track.file_id,
      caption,
      caption_entities: [
        {
          type: 'mention',
          offset: caption.indexOf('@'),
          length: botUsername.length + 1
        }
      ]
    }));
}

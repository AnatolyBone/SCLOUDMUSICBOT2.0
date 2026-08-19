export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
export const SHAZAM_FILE_TOO_BIG_MESSAGE = '⚠️ Файл слишком большой для распознавания.\nОтправьте короткий фрагмент трека — обычно достаточно 10–30 секунд.';

export function isShazamMediaTooLarge(media, limit = TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) {
  const size = Number(media?.file_size);
  return Number.isFinite(size) && size > limit;
}

export function isTelegramFileTooBigError(error) {
  const text = [error?.message, error?.description, error?.response?.description].filter(Boolean).join(' ');
  return /(?:400:\s*)?bad request:\s*file is too big/i.test(text);
}

export async function rejectOversizedShazamMedia(ctx, media) {
  if (!isShazamMediaTooLarge(media)) return false;
  await ctx.reply(SHAZAM_FILE_TOO_BIG_MESSAGE);
  return true;
}

export async function handleTelegramShazamFileTooBig(error, ctx) {
  if (!isTelegramFileTooBigError(error)) return false;
  await ctx.reply(SHAZAM_FILE_TOO_BIG_MESSAGE).catch(() => {});
  return true;
}

export async function getShazamFileLinkOrReply(ctx, media) {
  if (await rejectOversizedShazamMedia(ctx, media)) return null;
  try {
    return await ctx.telegram.getFileLink(media.file_id);
  } catch (error) {
    if (await handleTelegramShazamFileTooBig(error, ctx)) return null;
    throw error;
  }
}

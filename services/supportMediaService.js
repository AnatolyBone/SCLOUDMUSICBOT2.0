export const SUPPORT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const SUPPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export function validateSupportImage({ mimeType, size }) {
  if (!SUPPORT_IMAGE_MIME_TYPES.has(String(mimeType || '').toLowerCase())) throw new Error('Допустимы только PNG, JPG, JPEG и WEBP.');
  if (!Number.isFinite(Number(size)) || Number(size) <= 0 || Number(size) > SUPPORT_IMAGE_MAX_BYTES) throw new Error('Размер изображения не должен превышать 10 МБ.');
}

export async function storeTelegramSupportImage({ telegram, storage, fileId, mimeType, userId, fetchBuffer }) {
  const link = await telegram.getFileLink(fileId);
  const buffer = await fetchBuffer(typeof link === 'string' ? link : link.href);
  validateSupportImage({ mimeType, size: buffer.length });
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const storagePath = `${userId}/${Date.now()}-${String(fileId).replace(/[^A-Za-z0-9_-]/g, '')}.${extension}`;
  const { error } = await storage.upload(storagePath, buffer, { contentType: mimeType, upsert: false });
  if (error) throw error;
  return { storagePath, fileSize: buffer.length, mimeType };
}

export async function resolveSupportImage({ message, storage, telegram }) {
  if (message.storage_path) {
    const { data, error } = await storage.createSignedUrl(message.storage_path, 60);
    if (!error && data?.signedUrl) return { kind: 'redirect', url: data.signedUrl };
  }
  if (message.file_id) {
    const link = await telegram.getFileLink(message.file_id);
    return { kind: 'redirect', url: typeof link === 'string' ? link : link.href };
  }
  throw new Error('Вложение недоступно.');
}

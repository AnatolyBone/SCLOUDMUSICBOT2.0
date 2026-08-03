import { fileTypeFromBuffer } from 'file-type';
import { randomUUID } from 'crypto';

export const AD_CAMPAIGN_MEDIA_BUCKET = 'ad-campaign-media';
export const AD_CAMPAIGN_IMAGE_MIME_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif']);
export const AD_CAMPAIGN_VIDEO_MIME_TYPES = new Set(['video/mp4']);
export const AD_CAMPAIGN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const AD_CAMPAIGN_VIDEO_MAX_BYTES = 20 * 1024 * 1024;

export async function validateAdCampaignMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Файл пуст или не загружен.');
  const detected = await fileTypeFromBuffer(buffer);
  const mimeType = detected?.mime || '';
  const isImage = AD_CAMPAIGN_IMAGE_MIME_TYPES.has(mimeType);
  const isVideo = AD_CAMPAIGN_VIDEO_MIME_TYPES.has(mimeType);
  if (!isImage && !isVideo) throw new Error('Допустимы JPG, PNG, WEBP, GIF и MP4. SVG и HTML запрещены.');
  const maxBytes = isVideo ? AD_CAMPAIGN_VIDEO_MAX_BYTES : AD_CAMPAIGN_IMAGE_MAX_BYTES;
  if (buffer.length > maxBytes) throw new Error(`${isVideo ? 'Видео' : 'Изображение'} не должно превышать ${maxBytes / 1024 / 1024} МБ.`);
  return { mediaType:isVideo?'video':'image', mimeType, extension:detected.ext, size:buffer.length };
}

export async function uploadAdCampaignMedia({ storage, buffer, originalName = 'creative' }) {
  const detected = await validateAdCampaignMedia(buffer);
  const safeName = String(originalName).replace(/[^A-Za-z0-9._-]/g,'_').slice(-80) || `creative.${detected.extension}`;
  const storagePath = `${new Date().toISOString().slice(0,10)}/${randomUUID()}-${safeName}`;
  const { error } = await storage.upload(storagePath,buffer,{contentType:detected.mimeType,upsert:false,cacheControl:'3600'});
  if (error) throw new Error(`Не удалось сохранить медиа: ${error.message}`);
  return {media_type:detected.mediaType,media_storage_path:storagePath,media_mime_type:detected.mimeType,media_file_size:detected.size,media_file_name:originalName};
}

export async function removeAdCampaignMediaSafely({ storage, storagePath, isInUse }) {
  if (!storagePath || await isInUse(storagePath)) return false;
  const { error } = await storage.remove([storagePath]);
  if (error) throw new Error(`Не удалось удалить старое медиа: ${error.message}`);
  return true;
}

export async function downloadAdCampaignMedia({ storage, storagePath }) {
  const { data, error } = await storage.download(storagePath);
  if (error || !data) throw new Error(`Медиа кампании недоступно: ${error?.message || 'empty response'}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function createAdCampaignMediaSignedUrl({ storage, storagePath, expiresIn = 60 }) {
  const { data, error } = await storage.createSignedUrl(storagePath,expiresIn);
  if (error || !data?.signedUrl) throw new Error('Не удалось создать ссылку предпросмотра.');
  return data.signedUrl;
}

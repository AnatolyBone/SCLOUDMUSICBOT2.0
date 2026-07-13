function parseJsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function formatBroadcastKeyboard(keyboard) {
  const parsedKeyboard = parseJsonValue(keyboard, []);
  if (!Array.isArray(parsedKeyboard)) return '';

  return parsedKeyboard.flatMap(row => Array.isArray(row) ? row : [row]).map(button => {
    if (!button) return '';
    if (button.url) return `${button.text} | url | ${button.url}`;
    if (button.callback_data) return `${button.text} | callback | ${button.callback_data}`;
    if (button.switch_inline_query !== undefined) {
      return `${button.text} | inline_search | ${button.switch_inline_query}`;
    }
    return button.text || '';
  }).filter(Boolean).join('\n');
}

export function mapBroadcastTaskToForm(task, { clone = false } = {}) {
  const messages = parseJsonValue(task?.messages_json, {}) || {};
  const fallbackLanguage = task?.fallback_language === 'en' ? 'en' : 'ru';
  const legacyMessage = task?.message || '';
  const legacyKeyboard = parseJsonValue(task?.keyboard, []);

  let messageRu = messages.ru?.message || '';
  let messageEn = messages.en?.message || '';
  let keyboardRu = messages.ru?.keyboard;
  let keyboardEn = messages.en?.keyboard;

  if (!messageRu && !messageEn && legacyMessage) {
    if (fallbackLanguage === 'en') {
      messageEn = legacyMessage;
      keyboardEn = keyboardEn || legacyKeyboard;
    } else {
      messageRu = legacyMessage;
      keyboardRu = keyboardRu || legacyKeyboard;
    }
  }

  if (fallbackLanguage === 'en' && !keyboardEn && legacyKeyboard.length > 0) {
    keyboardEn = legacyKeyboard;
  }
  if (fallbackLanguage === 'ru' && !keyboardRu && legacyKeyboard.length > 0) {
    keyboardRu = legacyKeyboard;
  }

  const campaignBaseName = task?.campaign_name || (task?.id ? `Рассылка #${task.id}` : 'Рассылка');
  const campaignBaseTag = task?.campaign_tag || (task?.id ? `broadcast_${task.id}` : 'broadcast');

  return {
    ...(clone ? {} : task),
    campaign_name: clone ? `${campaignBaseName} (Копия)` : (task?.campaign_name || ''),
    campaign_tag: clone ? `${campaignBaseTag}_copy` : (task?.campaign_tag || ''),
    broadcast_type: task?.broadcast_type || 'marketing',
    target_audience: task?.target_audience || 'all',
    target_languages: Array.isArray(task?.target_languages) ? task.target_languages : ['all'],
    unknown_language_policy: task?.unknown_language_policy || 'use_ru',
    fallback_language: fallbackLanguage,
    message_ru: messageRu,
    message_en: messageEn,
    buttons_ru: formatBroadcastKeyboard(keyboardRu),
    buttons_en: formatBroadcastKeyboard(keyboardEn),
    file_id: task?.file_id || null,
    file_mime_type: task?.file_mime_type || null,
    disable_notification: Boolean(task?.disable_notification),
    disable_web_page_preview: Boolean(task?.disable_web_page_preview)
  };
}

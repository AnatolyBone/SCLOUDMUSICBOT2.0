export function countUndeliverableRecipients({
  ru = 0,
  en = 0,
  unknown = 0,
  messagesJson = {},
  fallbackLanguage = 'ru',
  unknownLanguagePolicy = 'use_ru'
} = {}) {
  const fallbackHasMessage = Boolean(messagesJson?.[fallbackLanguage]?.message);
  const canDeliverLanguage = language => Boolean(messagesJson?.[language]?.message) || fallbackHasMessage;

  let missing = 0;
  if (!canDeliverLanguage('ru')) missing += Number(ru) || 0;
  if (!canDeliverLanguage('en')) missing += Number(en) || 0;

  if (unknownLanguagePolicy !== 'exclude') {
    const unknownDeliveryLanguage = unknownLanguagePolicy === 'use_en' ? 'en' : 'ru';
    if (!canDeliverLanguage(unknownDeliveryLanguage)) missing += Number(unknown) || 0;
  }

  return missing;
}

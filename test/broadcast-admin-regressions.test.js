import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { countUndeliverableRecipients } from '../services/broadcastAudienceRules.js';
import { mapBroadcastTaskToForm } from '../services/broadcastFormMapper.js';

test('cloning a legacy broadcast restores its message and keyboard', () => {
  const clone = mapBroadcastTaskToForm({
    id: 92,
    message: '<b>Legacy campaign</b>',
    keyboard: [[
      { text: 'Open', url: 'https://example.com' },
      { text: 'Search', switch_inline_query: 'music' }
    ]],
    messages_json: null,
    fallback_language: 'ru',
    target_languages: ['all']
  }, { clone: true });

  assert.equal(clone.id, undefined);
  assert.equal(clone.campaign_name, 'Рассылка #92 (Копия)');
  assert.equal(clone.campaign_tag, 'broadcast_92_copy');
  assert.equal(clone.message_ru, '<b>Legacy campaign</b>');
  assert.equal(clone.message_en, '');
  assert.equal(
    clone.buttons_ru,
    'Open | url | https://example.com\nSearch | inline_search | music'
  );
});

test('audience estimate uses an available fallback translation', () => {
  const missing = countUndeliverableRecipients({
    ru: 10_665,
    en: 25,
    unknown: 4,
    messagesJson: { ru: { message: 'Fallback text' } },
    fallbackLanguage: 'ru',
    unknownLanguagePolicy: 'use_ru'
  });

  assert.equal(missing, 0);
  assert.equal(countUndeliverableRecipients({ ru: 10_665 }), 10_665);
});

test('estimate endpoint forwards fallback language to database rules', async () => {
  const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /messagesJson,\s*fallbackLanguage \|\| 'ru'/);
});

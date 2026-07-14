import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeBroadcastLaunchToken,
  issueBroadcastLaunchToken,
  sendBroadcastPreview,
  validateBroadcastLaunchRequest
} from '../services/broadcastSafety.js';

function createPreviewHarness() {
  const state = {
    taskCount: 65,
    logCount: 11_297,
    snapshotCalls: 0,
    deliveries: []
  };
  const sendBatch = async (_bot, task, recipients) => {
    state.deliveries.push({ task, recipients });
    return recipients.map(recipient => ({ status: 'ok', userId: recipient.id }));
  };
  return { state, sendBatch };
}

for (const language of ['ru', 'en']) {
  test(`preview ${language.toUpperCase()} sends exactly one message only to the authenticated admin`, async () => {
    const { state, sendBatch } = createPreviewHarness();
    const taskCountBefore = state.taskCount;
    const logCountBefore = state.logCount;

    const result = await sendBroadcastPreview({
      bot: { telegram: {} },
      adminId: 123456789,
      language,
      message: language === 'ru' ? 'Тест RU' : 'Test EN',
      sendBatch
    });

    assert.deepEqual(result, { ok: true, language, recipientCount: 1 });
    assert.equal(state.deliveries.length, 1);
    assert.deepEqual(state.deliveries[0].recipients, [
      { id: 123456789, first_name: 'Admin', delivered_language: language }
    ]);
    assert.equal(state.taskCount, taskCountBefore, 'preview must not create broadcast_tasks');
    assert.equal(state.logCount, logCountBefore, 'preview must not create broadcast_log');
    assert.equal(state.snapshotCalls, 0, 'preview must not create a recipient snapshot');
  });
}

test('repeated preview clicks remain single-recipient and never launch a campaign', async () => {
  const { state, sendBatch } = createPreviewHarness();
  for (let index = 0; index < 3; index++) {
    await sendBroadcastPreview({
      bot: { telegram: {} },
      adminId: 123456789,
      language: 'ru',
      message: `Preview ${index}`,
      sendBatch
    });
  }

  assert.equal(state.deliveries.length, 3);
  assert.ok(state.deliveries.every(item => item.recipients.length === 1));
  assert.equal(state.taskCount, 65);
  assert.equal(state.logCount, 11_297);
  assert.equal(state.snapshotCalls, 0);
});

test('launch defaults to deny without explicit action=launch', () => {
  let createdTasks = 0;
  assert.throws(
    () => {
      validateBroadcastLaunchRequest({}, {});
      createdTasks++;
    },
    error => error.code === 'BROADCAST_LAUNCH_INTENT_REQUIRED'
  );
  assert.throws(
    () => {
      validateBroadcastLaunchRequest({}, { action: 'preview_ru' });
      createdTasks++;
    },
    error => error.code === 'BROADCAST_LAUNCH_INTENT_REQUIRED'
  );
  assert.equal(createdTasks, 0, 'POST without action=launch must not create a campaign');
});

test('launch token is session-bound, expiring, and one-time', () => {
  const session = {};
  const token = issueBroadcastLaunchToken(session, 1_000);
  assert.equal(consumeBroadcastLaunchToken(session, token, 2_000), true);
  assert.equal(consumeBroadcastLaunchToken(session, token, 2_001), false);

  const expiredSession = {};
  const expiredToken = issueBroadcastLaunchToken(expiredSession, 1_000);
  assert.equal(consumeBroadcastLaunchToken(expiredSession, expiredToken, 1_000 + 5 * 60 * 1000 + 1), false);
});

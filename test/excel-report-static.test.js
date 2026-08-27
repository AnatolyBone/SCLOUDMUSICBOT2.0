import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts', 'generate_excel_report.py'), 'utf8');

test('Excel report keeps executive navigation and professional table behavior', () => {
  for (const marker of [
    'Executive Summary',
    'SCM Analytics Report',
    'write_url',
    'autofilter',
    'freeze_panes',
    'autofit',
    'conditional_format'
  ]) {
    assert.match(source, new RegExp(marker), `missing Excel feature: ${marker}`);
  }
});

test('Excel report includes trend formatting for core business metrics', () => {
  for (const metric of ['DAU', 'Выручка RUB', 'CTR', 'Конверсия 24ч']) {
    assert.ok(source.includes(metric), `missing metric presentation: ${metric}`);
  }
});

test('Excel report explicitly warns when analytics_daily truncates the requested period', () => {
  assert.match(source, /ВНИМАНИЕ: данные после \{end_date\} отсутствуют в analytics_daily/);
});

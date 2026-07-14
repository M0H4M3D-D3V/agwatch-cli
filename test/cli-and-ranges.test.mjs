import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseArgs } from '../dist/cli/parse-args.js';
import { resolveTimeRange } from '../dist/config/ranges.js';

const argv = (...args) => ['node', 'agwatch', ...args];

test('summary and dashboard use global range options in either position', () => {
  assert.equal(parseArgs(argv('summary', '--range', 'today')).range, 'today');
  assert.equal(parseArgs(argv('--range', '30d', 'summary')).range, '30d');
  assert.equal(parseArgs(argv('dashboard', '--range', 'month')).range, 'month');
  assert.equal(parseArgs(argv('--range', 'today', 'dashboard')).range, 'today');
});

test('default invocation remains the seven-day dashboard', () => {
  const result = parseArgs(argv());
  assert.equal(result.command, 'dashboard');
  assert.equal(result.range, '7d');
});

test('summary retains custom dates and JSON output', () => {
  const result = parseArgs(argv('summary', '--from', '2026-07-01', '--to', '2026-07-14', '--json'));
  assert.deepEqual(result, {
    command: 'summary',
    range: '7d',
    from: '2026-07-01',
    to: '2026-07-14',
    json: true,
  });
});

test('custom ranges are strict, complete, ordered, and inclusive', () => {
  const leapDay = resolveTimeRange(undefined, '2024-02-29', '2024-02-29');
  assert.equal(leapDay.label, '2024-02-29 to 2024-02-29');
  assert.equal(leapDay.from.getHours(), 0);
  assert.equal(leapDay.to.getHours(), 23);

  assert.throws(() => resolveTimeRange(undefined, '2026-02-30', '2026-03-01'), /valid calendar date/);
  assert.throws(() => resolveTimeRange(undefined, '2026-2-01', '2026-02-02'), /YYYY-MM-DD/);
  assert.throws(() => resolveTimeRange(undefined, '2026-05-02', '2026-05-01'), /on or before/);
  assert.throws(() => resolveTimeRange(undefined, '2026-05-01'), /provided together/);
});

test('summary help lists global and local options', () => {
  const result = spawnSync(process.execPath, ['dist/cli/index.js', 'summary', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Global Options:/);
  assert.match(result.stdout, /--range <range>/);
  assert.match(result.stdout, /--json/);
});

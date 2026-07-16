import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchAnthropicUsageApi, parseAnthropicUsage } from '../dist/providers/anthropic-api.js';
import { extractUsageLimitsFromPage } from '../dist/providers/dom-usage-limits.js';
import { parseOpenAIUsage } from '../dist/providers/openai-api.js';
import { parseOpenCodeGoUsageHtml } from '../dist/providers/opencodego-api.js';
import { parseZAIUsage } from '../dist/providers/zai-api.js';
import { shouldFallbackToBrowser } from '../dist/providers/fallback-policy.js';
import { extractUsageLimits, getProviderLimits } from '../dist/providers/usage-limits.js';

test('generic extraction discovers additional contextual limits and rejects unrelated percentages', () => {
  const limits = extractUsageLimits({
    usage: {
      daily_window: { label: 'Daily', used_percent: 12, reset_after_seconds: 60 },
      project_quota: { consumed: 25, limit: 100 },
    },
    billing: { discount_percent: 80 },
    profile_completion: { percentage: 90 },
    cards: { rate_limit: [{ label: 'Profile completion', percentage: 75 }] },
  }, { observedAt: Date.now() });

  assert.deepEqual(limits.map((limit) => [limit.label, limit.usedPercent]), [
    ['Daily', 12],
    ['Project Quota', 25],
  ]);
  assert.notEqual(limits[0].resetDate, '--');
});

test('generic percentage wrappers do not hide meaningful child limits', () => {
  const limits = extractUsageLimits({
    usage: {
      percentage: 99,
      rollingUsage: { usagePercent: 10, resetInSec: 3600 },
    },
  }, { aliases: { rollingUsage: 'Rolling usage' } });
  assert.deepEqual(limits.map((limit) => [limit.id, limit.label, limit.usedPercent]), [
    ['usage/rollingUsage', 'Rolling usage', 10],
  ]);
});

test('nested child labels do not label or fabricate their percentage wrapper', () => {
  const limits = extractUsageLimits({
    usage: {
      percentage: 99,
      limits: [{ label: 'Daily tokens', percentage: 10 }],
    },
  });
  assert.deepEqual(limits.map((limit) => [limit.label, limit.usedPercent]), [['Daily Tokens', 10]]);
});

test('generic extraction accepts common used-percentage names and preserves changed snapshots', () => {
  const limits = extractUsageLimits({
    token_limits: [
      { id: 'dynamic', label: 'Dynamic quota', usedPercentage: 10, reset_at: 1_800_000_000 },
      { id: 'dynamic', label: 'Dynamic quota', percent_used: 20, reset_at: 1_800_003_600 },
    ],
  });
  assert.deepEqual(limits.map((limit) => limit.usedPercent), [10, 20]);
});

test('missing dynamic limits never fabricate legacy rows', () => {
  assert.deepEqual(getProviderLimits({
    providerId: 'example',
    providerLabel: 'Example',
    color: '#fff',
    sessionUsedPct: 90,
    weeklyUsedPct: 80,
    sessionResetDate: 'later',
    weeklyResetDate: 'later',
    scrapedAt: Date.now(),
  }), []);
});

test('OpenAI dynamically includes every returned usage window', () => {
  const data = parseOpenAIUsage({
    rate_limit: {
      primary_window: { used_percent: 20, reset_after_seconds: 300, limit_window_seconds: 10_800 },
      secondary_window: { used_percent: 40, reset_after_seconds: 600, limit_window_seconds: 604_800 },
      daily_window: { used_percent: 10, reset_after_seconds: 120 },
    },
  });
  assert.deepEqual(data.limits.map((limit) => limit.label), ['3 hours', '7 days', 'Daily Window']);
  assert.equal(data.sessionUsedPct, 20);
  assert.equal(data.weeklyUsedPct, 40);
});

test('OpenAI does not claim a fixed duration when window metadata is absent', () => {
  const data = parseOpenAIUsage({
    rate_limit: { primary_window: { used_percent: 19, reset_after_seconds: 300 } },
  });
  assert.deepEqual(data.limits.map((limit) => limit.label), ['Primary window']);
});

test('same-named windows in different provider scopes remain distinct', () => {
  const limits = extractUsageLimits({
    rate_limit: { primary_window: { used_percent: 10, reset_at: 1_800_000_000 } },
    code_review_rate_limit: { primary_window: { used_percent: 10, reset_at: 1_800_000_000 } },
  }, { aliases: { primary_window: 'Primary window' } });
  assert.deepEqual(limits.map((limit) => limit.id), [
    'rate_limit/primary_window',
    'code_review_rate_limit/primary_window',
  ]);
});

test('default browser fallback covers provider endpoint and schema changes', () => {
  assert.equal(shouldFallbackToBrowser('endpoint_not_found', 'on_auth_error'), true);
  assert.equal(shouldFallbackToBrowser('payload_invalid', 'on_auth_error'), true);
  assert.equal(shouldFallbackToBrowser('network_error', 'on_auth_error'), false);
});

test('Anthropic does not fabricate missing limits and accepts zero usage without reset', () => {
  const data = parseAnthropicUsage({ seven_day: { utilization: 0, resets_at: null } });
  assert.deepEqual(data.limits.map((limit) => limit.label), ['7 days']);
  assert.equal(data.limits[0].usedPercent, 0);
  assert.equal(data.limits[0].resetDate, '--');
  assert.equal(getProviderLimits(data).length, 1);
});

test('Anthropic retries transient responses and tries the next organization', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response('{}', { status: 503 });
    if (String(url).endsWith('/api/organizations')) {
      return Response.json([{ uuid: 'first' }, { uuid: 'second' }]);
    }
    if (String(url).includes('/first/')) return new Response('{}', { status: 403 });
    return Response.json({ five_hour: { utilization: 12, resets_at: null } });
  };

  const data = await fetchAnthropicUsageApi({
    providerId: 'anthropic',
    cookieHeader: 'session=test',
    cookiesByName: { session: 'test' },
  }, 5_000);
  assert.equal(data.limits[0].usedPercent, 12);
  assert.equal(calls.filter((url) => url.endsWith('/api/organizations')).length, 2);
  assert.equal(calls.some((url) => url.includes('/first/usage')), true);
  assert.equal(calls.some((url) => url.includes('/second/usage')), true);
});

test('array-based Claude limits use model and semantic labels instead of numeric indexes', () => {
  const data = parseAnthropicUsage({
    seven_day_by_model: [
      { model: 'claude-opus-4', utilization: 10, resets_at: null },
      { model_name: 'claude-sonnet-4', utilization: 20, resets_at: null },
    ],
    rolling_limits: [
      { utilization: 30, resets_at: null },
      { utilization: 40, resets_at: null },
    ],
  });
  assert.deepEqual(data.limits.map((limit) => limit.label), [
    'Claude Opus 4',
    'Claude Sonnet 4',
    'Rolling Limits (1)',
    'Rolling Limits (2)',
  ]);
  assert.equal(data.limits.some((limit) => /^\d+$/.test(limit.label)), false);
});

test('Anthropic ignores anonymous generic records and discovers nested scoped labels', () => {
  const data = parseAnthropicUsage({
    five_hour: { utilization: 81, resets_at: '2026-07-15T04:50:00Z' },
    seven_day: { utilization: 52, resets_at: '2026-07-20T12:00:00Z' },
    limits: [
      { utilization: 81, resets_at: '2026-07-15T04:50:00Z' },
      { utilization: 52, resets_at: '2026-07-20T12:00:00Z' },
      { utilization: 0, resets_at: null },
      {
        percent: 7,
        resets_at: null,
        scope: { model: { id: 'temporary-model-id', display_name: 'Experimental Model' } },
      },
    ],
  });
  assert.deepEqual(data.limits.map((limit) => [limit.id, limit.label]), [
    ['five_hour', '5 hours'],
    ['seven_day', '7 days'],
    ['temporary-model-id', 'Experimental Model'],
  ]);
});

test('Z.AI maps every quota record rather than selecting two units', () => {
  const data = parseZAIUsage({ data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 11, nextResetTime: Date.now() + 1000 },
    { type: 'TOKENS_LIMIT', unit: 6, percentage: 22, nextResetTime: Date.now() + 2000 },
    { type: 'REQUESTS_LIMIT', unit: 1, percentage: 33, nextResetTime: Date.now() + 3000 },
  ] } });
  assert.deepEqual(data.limits.map((limit) => limit.usedPercent), [11, 22, 33]);
  assert.deepEqual(data.limits.slice(0, 2).map((limit) => limit.label), ['TOKENS LIMIT 3', 'TOKENS LIMIT 6']);
  assert.deepEqual(data.limits.map((limit) => limit.id), ['TOKENS_LIMIT:3', 'TOKENS_LIMIT:6', 'REQUESTS_LIMIT:1']);
  assert.equal(data.sessionUsedPct, 11);
  assert.equal(data.weeklyUsedPct, 22);
});

test('Z.AI keeps typed identities when API window durations provide dynamic labels', () => {
  const data = parseZAIUsage({ data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 11, limit_window_seconds: 10_800 },
    { type: 'TOKENS_LIMIT', unit: 6, percentage: 22, limit_window_seconds: 604_800 },
  ] } });
  assert.deepEqual(data.limits.map((limit) => [limit.id, limit.label]), [
    ['TOKENS_LIMIT:3', '3 hours'],
    ['TOKENS_LIMIT:6', '7 days'],
  ]);
  assert.equal(data.sessionUsedPct, 11);
  assert.equal(data.weeklyUsedPct, 22);
});

test('OpenCode Go discovers unknown embedded usage blocks automatically', () => {
  const html = `
    rollingUsage:$R[1]={status:"ok",resetInSec:3600,usagePercent:10}
    weeklyUsage:$R[2]={status:"ok",resetInSec:7200,usagePercent:20}
    dailyUsage:$R[3]={status:"ok",resetInSec:1800,usagePercent:30}
  `;
  const data = parseOpenCodeGoUsageHtml(html);
  assert.deepEqual(data.limits.map((limit) => limit.usedPercent), [10, 20, 30]);
  assert.deepEqual(data.limits.map((limit) => limit.label), ['Rolling usage', 'Weekly', 'Daily Usage']);
});

test('OpenCode Go accepts spaced and quoted embedded usage fields', () => {
  const data = parseOpenCodeGoUsageHtml(`
    "rollingUsage" : $R[1] = { "resetInSec": "3600", "usagePercent": "10" }
    'weeklyUsage' : $R[2] = { 'usagePercent': 20, 'resetInSec': 7200 }
  `);
  assert.deepEqual(data.limits.map((limit) => [limit.id, limit.usedPercent]), [
    ['rollingUsage', 10],
    ['weeklyUsage', 20],
  ]);
});

test('OpenCode Go merges embedded and visible limits with dynamic suffixes', () => {
  const data = parseOpenCodeGoUsageHtml(`
    rollingUsage:$R[1]={resetInSec:3600,usagePercent:10}
    requestQuota:$R[2]={resetInSec:7200,usagePercent:30}
    <section>Daily Token Limit 40% Resets in 1 day</section>
  `);
  assert.deepEqual(data.limits.map((limit) => [limit.label, limit.usedPercent]), [
    ['Rolling usage', 10],
    ['Request Quota', 30],
    ['Daily Token Limit', 40],
  ]);
});

test('OpenCode Go text cards keep each reset paired with its own label', () => {
  const data = parseOpenCodeGoUsageHtml(`
    <section>OpenCode Go Subscription Rolling Usage 10% Resets in 2 hours</section>
    <section>Weekly Usage 20% Resets in 5 days</section>
  `);
  assert.deepEqual(data.limits.map((limit) => [limit.label, limit.resetDate]), [
    ['Rolling Usage', '2 hours'],
    ['Weekly Usage', '5 days'],
  ]);
});

test('OpenCode Go text cards preserve dynamic duration labels and remove duplicates', () => {
  const data = parseOpenCodeGoUsageHtml(`
    <section>Subscription 3 Hour Usage 10% Resets in 2 hours Upgrade plan</section>
    <section>Subscription 3 Hour Usage 10% Resets in 2 hours</section>
    <section>Weekly Usage 20% Resets in 5 days</section>
  `);
  assert.deepEqual(data.limits.map((limit) => [limit.id, limit.label, limit.resetDate]), [
    ['3 Hour Usage', '3 Hour Usage', '2 hours'],
    ['Weekly Usage', 'Weekly Usage', '5 days'],
  ]);
  assert.equal(data.sessionUsedPct, 10);
  assert.equal(data.weeklyUsedPct, 20);
});

test('OpenCode Go rejects pages without parseable usage', () => {
  assert.throws(
    () => parseOpenCodeGoUsageHtml('<html><body>Sign in</body></html>'),
    /Could not parse OpenCode Go usage data/,
  );
});

test('DOM extraction keeps labels and resets paired per card and deduplicates rows', async () => {
  const page = {
    evaluate: async () => [
      { label: '5 hour usage', percent: 12, reset: '2 hours' },
      { label: '5 hour usage', percent: 12, reset: '2 hours' },
      { label: 'Weekly usage', percent: 44, reset: 'Friday 10:00' },
    ],
  };
  const limits = await extractUsageLimitsFromPage(page);
  assert.deepEqual(limits.map((limit) => [limit.label, limit.usedPercent, limit.resetDate]), [
    ['5 hour usage', 12, '2 hours'],
    ['Weekly usage', 44, 'Friday 10:00'],
  ]);
});

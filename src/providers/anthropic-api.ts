import type { ProviderUsageData } from './types.js';
import type { ProviderSession } from './session.js';
import { setTimeout as delay } from 'node:timers/promises';
import { httpRequest } from './http-client.js';
import type { HttpResponse } from './http-client.js';
import { ProviderScrapeError } from './errors.js';
import { CHROME_UA } from './constants.js';
import { extractUsageLimits, legacyFieldsFromLimits } from './usage-limits.js';

type AnthropicOrg = {
  uuid?: string;
  id?: string;
};

type RawUsageResponse = Record<string, any>;

async function requestWithRetry<T>(
  request: (timeoutMs: number) => Promise<HttpResponse<T>>,
  deadline: number,
  signal?: AbortSignal,
): Promise<HttpResponse<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProviderScrapeError('timeout', 'Anthropic API deadline exceeded', true);
    try {
      const response = await request(Math.max(250, Math.min(6_000, remaining)));
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new ProviderScrapeError('network_error', `Anthropic request failed (${response.status})`, true);
      if (attempt === 1) return response;
    } catch (err) {
      signal?.throwIfAborted();
      lastError = err;
      if (attempt === 1) throw err;
    }
    const retryDelay = Math.min(250, Math.max(0, deadline - Date.now()));
    if (retryDelay > 0) await delay(retryDelay, undefined, { signal });
  }
  throw lastError;
}

export function parseAnthropicUsage(raw: RawUsageResponse): ProviderUsageData {
  const limits = extractUsageLimits(raw, {
    aliases: { five_hour: '5 hours', seven_day: '7 days' },
  });
  if (limits.length === 0) {
    throw new ProviderScrapeError('payload_invalid', 'Anthropic usage payload invalid', true);
  }
  return {
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    color: '#C77DFF',
    ...legacyFieldsFromLimits(limits),
    limits,
    scrapedAt: Date.now(),
  };
}

function isValidUsagePayload(raw: RawUsageResponse | undefined): boolean {
  return extractUsageLimits(raw, { aliases: { five_hour: '5 hours', seven_day: '7 days' } }).length > 0;
}

export async function fetchAnthropicUsageApi(
  session: ProviderSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderUsageData> {
  const deadline = Date.now() + timeoutMs;
  const headers = {
      'accept': 'application/json, text/plain, */*',
      'cookie': session.cookieHeader,
      'origin': 'https://claude.ai',
      'referer': 'https://claude.ai/settings/usage',
      'user-agent': CHROME_UA,
  };
  const orgsRes = await requestWithRetry<AnthropicOrg[]>(
    (requestTimeoutMs) => httpRequest({
      url: 'https://claude.ai/api/organizations',
      timeoutMs: requestTimeoutMs,
      signal,
      headers,
    }),
    deadline,
    signal,
  );

  if (orgsRes.status === 401 || orgsRes.status === 403) {
    throw new ProviderScrapeError('unauthorized', `Anthropic organizations unauthorized (${orgsRes.status})`, false);
  }
  if (!orgsRes.ok) {
    throw new ProviderScrapeError('network_error', `Anthropic organizations request failed (${orgsRes.status})`, true);
  }

  const orgIds = [...new Set(
    (Array.isArray(orgsRes.json) ? orgsRes.json : [])
      .map((org) => org?.uuid || org?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];
  if (orgIds.length === 0) {
    throw new ProviderScrapeError('payload_invalid', 'Anthropic organization id not found', true);
  }

  let lastFailure: ProviderScrapeError | undefined;
  for (const orgId of orgIds) {
    const usageRes = await requestWithRetry<RawUsageResponse>(
      (requestTimeoutMs) => httpRequest({
        url: `https://claude.ai/api/organizations/${orgId}/usage`,
        timeoutMs: requestTimeoutMs,
        signal,
        headers,
      }),
      deadline,
      signal,
    );
    if (usageRes.status === 401 || usageRes.status === 403) {
      lastFailure = new ProviderScrapeError('unauthorized', `Anthropic usage unauthorized (${usageRes.status})`, false);
      continue;
    }
    if (usageRes.status === 404) {
      lastFailure = new ProviderScrapeError('endpoint_not_found', 'Anthropic usage endpoint not found', false);
      continue;
    }
    if (!usageRes.ok) {
      lastFailure = new ProviderScrapeError('network_error', `Anthropic usage request failed (${usageRes.status})`, true);
      continue;
    }
    if (!isValidUsagePayload(usageRes.json)) {
      lastFailure = new ProviderScrapeError('payload_invalid', 'Anthropic usage payload invalid', true);
      continue;
    }
    return parseAnthropicUsage(usageRes.json!);
  }
  throw lastFailure ?? new ProviderScrapeError('payload_invalid', 'Anthropic usage payload invalid', true);
}

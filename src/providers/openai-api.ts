import type { ProviderUsageData } from './types.js';
import type { ProviderSession } from './session.js';
import { httpRequest } from './http-client.js';
import { ProviderScrapeError } from './errors.js';
import { CHROME_UA } from './constants.js';
import { extractUsageLimits, legacyFieldsFromLimits } from './usage-limits.js';

type WhamUsageResponse = {
  rate_limit?: {
    primary_window?: {
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
      limit_window_seconds?: number;
    };
    secondary_window?: {
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
      limit_window_seconds?: number;
    };
  };
  [key: string]: unknown;
};

type SessionResponse = {
  accessToken?: string;
};

export async function fetchOpenAIUsageApi(
  session: ProviderSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderUsageData> {
  const accessToken = await fetchAccessToken(session, timeoutMs, signal);

  const res = await httpRequest<WhamUsageResponse>({
    url: 'https://chatgpt.com/backend-api/wham/usage',
    timeoutMs,
    signal,
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${accessToken}`,
      origin: 'https://chatgpt.com',
      referer: 'https://chatgpt.com/codex/cloud/settings/usage',
      'user-agent': CHROME_UA,
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new ProviderScrapeError(
      'unauthorized',
      `OpenAI usage unauthorized (${res.status})`,
      false,
    );
  }
  if (res.status === 404) {
    throw new ProviderScrapeError(
      'endpoint_not_found',
      'OpenAI usage endpoint not found',
      false,
    );
  }
  if (!res.ok) {
    throw new ProviderScrapeError(
      'network_error',
      `OpenAI usage request failed (${res.status})`,
      true,
    );
  }

  return parseOpenAIUsage(res.json);
}

export function parseOpenAIUsage(data: unknown): ProviderUsageData {
  const limits = extractUsageLimits(data, {
    aliases: {
      primary_window: 'Primary window',
      secondary_window: 'Secondary window',
    },
  });
  if (limits.length === 0) {
    throw new ProviderScrapeError('payload_invalid', 'OpenAI usage payload invalid', true);
  }
  return {
    providerId: 'openai',
    providerLabel: 'OpenAI',
    color: '#5BE0F5',
    ...legacyFieldsFromLimits(limits),
    limits,
    scrapedAt: Date.now(),
  };
}

async function fetchAccessToken(
  session: ProviderSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await httpRequest<SessionResponse>({
    url: 'https://chatgpt.com/api/auth/session',
    timeoutMs,
    signal,
    headers: {
      accept: 'application/json',
      cookie: session.cookieHeader,
      'user-agent': CHROME_UA,
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new ProviderScrapeError(
      'unauthorized',
      `OpenAI session unauthorized (${res.status})`,
      false,
    );
  }
  if (!res.ok) {
    throw new ProviderScrapeError(
      'network_error',
      `OpenAI session request failed (${res.status})`,
      true,
    );
  }

  const token = res.json?.accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new ProviderScrapeError(
      'unauthorized',
      'OpenAI session returned no access token',
      false,
    );
  }

  return token;
}

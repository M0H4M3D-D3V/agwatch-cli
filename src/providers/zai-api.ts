import type { ProviderUsageData } from './types.js';
import type { ProviderSession } from './session.js';
import { httpRequest } from './http-client.js';
import { ProviderScrapeError } from './errors.js';
import { CHROME_UA } from './constants.js';
import { extractUsageLimits, legacyFieldsFromLimits } from './usage-limits.js';

type ZaiLoginResponse = {
  code?: number;
  data?: {
    access_token?: string;
  };
};

type ZaiQuotaLimit = {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  nextResetTime?: number;
};

type ZaiQuotaResponse = {
  code?: number;
  data?: {
    limits?: ZaiQuotaLimit[];
    level?: string;
  };
  success?: boolean;
};

export async function fetchZAIUsageApi(
  session: ProviderSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderUsageData> {
  const chatToken = session.cookiesByName['token'] || session.bearerToken;
  if (!chatToken) {
    throw new ProviderScrapeError('unauthorized', 'Z.AI token cookie missing', false);
  }

  const loginRes = await httpRequest<ZaiLoginResponse>({
    url: 'https://api.z.ai/api/auth/z/login',
    method: 'POST',
    timeoutMs,
    signal,
    headers: {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'origin': 'https://z.ai',
      'referer': 'https://z.ai/manage-apikey/subscription',
      'user-agent': CHROME_UA,
    },
    body: JSON.stringify({ token: chatToken }),
  });

  if (loginRes.status === 401 || loginRes.status === 403) {
    throw new ProviderScrapeError('unauthorized', `Z.AI login exchange unauthorized (${loginRes.status})`, false);
  }
  if (!loginRes.ok) {
    throw new ProviderScrapeError('network_error', `Z.AI login exchange failed (${loginRes.status})`, true);
  }

  const accessToken = loginRes.json?.data?.access_token;
  if (!accessToken) {
    throw new ProviderScrapeError('unauthorized', 'Z.AI access token exchange failed', false);
  }

  const quotaRes = await httpRequest<ZaiQuotaResponse>({
    url: 'https://api.z.ai/api/monitor/usage/quota/limit',
    timeoutMs,
    signal,
    headers: {
      'accept': 'application/json, text/plain, */*',
      'authorization': `Bearer ${accessToken}`,
      'origin': 'https://z.ai',
      'referer': 'https://z.ai/manage-apikey/subscription',
      'user-agent': CHROME_UA,
    },
  });

  if (quotaRes.status === 401 || quotaRes.status === 403) {
    throw new ProviderScrapeError('unauthorized', `Z.AI quota unauthorized (${quotaRes.status})`, false);
  }
  if (quotaRes.status === 404) {
    throw new ProviderScrapeError('endpoint_not_found', 'Z.AI quota endpoint not found', false);
  }
  if (!quotaRes.ok) {
    throw new ProviderScrapeError('network_error', `Z.AI quota request failed (${quotaRes.status})`, true);
  }

  return parseZAIUsage(quotaRes.json);
}

export function parseZAIUsage(payload: unknown): ProviderUsageData {
  const limits = extractUsageLimits(payload, {
    aliases: {
      five_hour: '5 hours',
      seven_day: '7 days',
    },
  });
  if (limits.length === 0) {
    throw new ProviderScrapeError('payload_invalid', 'Z.AI quota payload missing usage limits', true);
  }
  return {
    providerId: 'zai',
    providerLabel: 'Z.AI',
    color: '#4A90D9',
    ...legacyFieldsFromLimits(limits),
    limits,
    scrapedAt: Date.now(),
  };
}

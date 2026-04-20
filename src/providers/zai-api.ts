import type { ProviderUsageData } from './types.js';
import type { ProviderSession } from './session.js';
import { httpRequest } from './http-client.js';
import { ProviderScrapeError } from './errors.js';
import { CHROME_UA } from './constants.js';
import { clampPct, formatDateShort } from './format-utils.js';

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

export async function fetchZAIUsageApi(session: ProviderSession, timeoutMs: number): Promise<ProviderUsageData> {
  const chatToken = session.cookiesByName['token'] || session.bearerToken;
  if (!chatToken) {
    throw new ProviderScrapeError('unauthorized', 'Z.AI token cookie missing', false);
  }

  const loginRes = await httpRequest<ZaiLoginResponse>({
    url: 'https://api.z.ai/api/auth/z/login',
    method: 'POST',
    timeoutMs,
    headers: {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'origin': 'https://z.ai',
      'referer': 'https://z.ai/manage-apikey/subscription',
      'user-agent': CHROME_UA,
    },
    body: JSON.stringify({ token: chatToken }),
  });

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
  if (!quotaRes.ok) {
    throw new ProviderScrapeError('network_error', `Z.AI quota request failed (${quotaRes.status})`, true);
  }

  const limits = quotaRes.json?.data?.limits;
  if (!Array.isArray(limits) || limits.length === 0) {
    throw new ProviderScrapeError('payload_invalid', 'Z.AI quota payload missing limits', true);
  }

  const tokenLimits = limits.filter((l) => l.type === 'TOKENS_LIMIT');
  if (tokenLimits.length === 0) {
    throw new ProviderScrapeError('payload_invalid', 'Z.AI quota payload missing TOKENS_LIMIT', true);
  }

  const sessionLimit = tokenLimits.find((l) => l.unit === 3) ?? tokenLimits[0];
  const weeklyLimit = tokenLimits.find((l) => l.unit === 6) ?? tokenLimits[1] ?? tokenLimits[0];

  const sessionUsedPct = clampPct(sessionLimit.percentage ?? 0);
  const weeklyUsedPct = clampPct(weeklyLimit.percentage ?? 0);

  return {
    providerId: 'zai',
    providerLabel: 'Z.AI',
    color: '#4A90D9',
    sessionUsedPct,
    weeklyUsedPct,
    sessionResetDate: formatReset(sessionLimit.nextResetTime),
    weeklyResetDate: formatReset(weeklyLimit.nextResetTime),
    scrapedAt: Date.now(),
  };
}

function formatReset(ms?: number): string {
  if (!Number.isFinite(ms as number) || (ms as number) <= 0) return '--';
  const d = new Date(ms as number);
  if (Number.isNaN(d.getTime())) return '--';
  return formatDateShort(d);
}

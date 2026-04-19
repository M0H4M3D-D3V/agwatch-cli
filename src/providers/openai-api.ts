import type { ProviderUsageData } from './types.js';
import type { ProviderSession } from './session.js';
import { httpRequest } from './http-client.js';
import { ProviderScrapeError } from './errors.js';
import { CHROME_UA } from './constants.js';
import { clampPct, formatDateShort } from './format-utils.js';

type WhamUsageResponse = {
  rate_limit?: {
    primary_window?: {
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
    };
    secondary_window?: {
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
    };
  };
};

type SessionResponse = {
  accessToken?: string;
};

export async function fetchOpenAIUsageApi(
  session: ProviderSession,
  timeoutMs: number,
): Promise<ProviderUsageData> {
  const accessToken = await fetchAccessToken(session, timeoutMs);

  const res = await httpRequest<WhamUsageResponse>({
    url: 'https://chatgpt.com/backend-api/wham/usage',
    timeoutMs,
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

  const data = res.json;
  if (!isValidWhamUsageResponse(data)) {
    throw new ProviderScrapeError(
      'payload_invalid',
      'OpenAI usage payload invalid',
      true,
    );
  }

  const primary = data.rate_limit!.primary_window;
  const secondary = data.rate_limit!.secondary_window;
  const sessionUsedPct = clampPct(primary?.used_percent ?? 0);
  const weeklyUsedPct = clampPct(secondary?.used_percent ?? 0);

  return {
    providerId: 'openai',
    providerLabel: 'OpenAI',
    color: '#5BE0F5',
    sessionUsedPct,
    weeklyUsedPct,
    sessionResetDate: formatReset(
      primary?.reset_at,
      primary?.reset_after_seconds,
    ),
    weeklyResetDate: formatReset(
      secondary?.reset_at,
      secondary?.reset_after_seconds,
    ),
    scrapedAt: Date.now(),
  };
}

async function fetchAccessToken(
  session: ProviderSession,
  timeoutMs: number,
): Promise<string> {
  const res = await httpRequest<SessionResponse>({
    url: 'https://chatgpt.com/api/auth/session',
    timeoutMs,
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

function isValidWhamUsageResponse(
  data: WhamUsageResponse | undefined,
): data is WhamUsageResponse {
  if (!data || typeof data !== 'object') return false;
  const rl = data.rate_limit;
  if (!rl || typeof rl !== 'object') return false;
  const p = rl.primary_window;
  const s = rl.secondary_window;

  const hasPrimary =
    !!p &&
    Number.isFinite(p.used_percent as number) &&
    (Number.isFinite(p.reset_at as number) ||
      Number.isFinite(p.reset_after_seconds as number));
  const hasSecondary =
    !!s &&
    Number.isFinite(s.used_percent as number) &&
    (Number.isFinite(s.reset_at as number) ||
      Number.isFinite(s.reset_after_seconds as number));

  return hasPrimary || hasSecondary;
}

function formatReset(
  resetAtEpochSec?: number,
  resetAfterSec?: number,
): string {
  if (
    Number.isFinite(resetAtEpochSec as number) &&
    (resetAtEpochSec as number) > 0
  ) {
    return formatDateShort(new Date((resetAtEpochSec as number) * 1000));
  }
  if (
    Number.isFinite(resetAfterSec as number) &&
    (resetAfterSec as number) > 0
  ) {
    return formatDateShort(new Date(Date.now() + (resetAfterSec as number) * 1000));
  }
  return '--';
}

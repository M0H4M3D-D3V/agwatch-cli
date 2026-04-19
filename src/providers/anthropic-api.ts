import type { ProviderUsageData } from './types.js';
import type { ProviderSession } from './session.js';
import { httpRequest } from './http-client.js';
import { ProviderScrapeError } from './errors.js';
import { CHROME_UA } from './constants.js';
import { clampPct, formatDateShort } from './format-utils.js';

type AnthropicOrg = {
  uuid?: string;
  id?: string;
};

type AnthropicUsageResponse = {
  five_hour?: {
    utilization?: number;
    resets_at?: string | null;
  };
  seven_day?: {
    utilization?: number;
    resets_at?: string | null;
  };
};

export async function fetchAnthropicUsageApi(session: ProviderSession, timeoutMs: number): Promise<ProviderUsageData> {
  const orgsRes = await httpRequest<AnthropicOrg[]>({
    url: 'https://claude.ai/api/organizations',
    timeoutMs,
    headers: {
      'accept': 'application/json, text/plain, */*',
      'cookie': session.cookieHeader,
      'origin': 'https://claude.ai',
      'referer': 'https://claude.ai/settings/usage',
      'user-agent': CHROME_UA,
    },
  });

  if (orgsRes.status === 401 || orgsRes.status === 403) {
    throw new ProviderScrapeError('unauthorized', `Anthropic organizations unauthorized (${orgsRes.status})`, false);
  }
  if (!orgsRes.ok) {
    throw new ProviderScrapeError('network_error', `Anthropic organizations request failed (${orgsRes.status})`, true);
  }

  const orgs = Array.isArray(orgsRes.json) ? orgsRes.json : [];
  const orgId = (orgs.find((o) => !!o?.uuid)?.uuid) || (orgs.find((o) => !!o?.id)?.id);
  if (!orgId) {
    throw new ProviderScrapeError('payload_invalid', 'Anthropic organization id not found', true);
  }

  const usageRes = await httpRequest<AnthropicUsageResponse>({
    url: `https://claude.ai/api/organizations/${orgId}/usage`,
    timeoutMs,
    headers: {
      'accept': 'application/json, text/plain, */*',
      'cookie': session.cookieHeader,
      'origin': 'https://claude.ai',
      'referer': 'https://claude.ai/settings/usage',
      'user-agent': CHROME_UA,
    },
  });

  if (usageRes.status === 401 || usageRes.status === 403) {
    throw new ProviderScrapeError('unauthorized', `Anthropic usage unauthorized (${usageRes.status})`, false);
  }
  if (usageRes.status === 404) {
    throw new ProviderScrapeError('endpoint_not_found', 'Anthropic usage endpoint not found', false);
  }
  if (!usageRes.ok) {
    throw new ProviderScrapeError('network_error', `Anthropic usage request failed (${usageRes.status})`, true);
  }

  const data = usageRes.json;
  if (!isValidAnthropicUsageResponse(data)) {
    throw new ProviderScrapeError('payload_invalid', 'Anthropic usage payload invalid', true);
  }

  return {
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    color: '#C77DFF',
    sessionUsedPct: toPct(data.five_hour?.utilization),
    weeklyUsedPct: toPct(data.seven_day?.utilization),
    sessionResetDate: formatIsoReset(data.five_hour?.resets_at ?? null),
    weeklyResetDate: formatIsoReset(data.seven_day?.resets_at ?? null),
    scrapedAt: Date.now(),
  };
}

function isValidAnthropicUsageResponse(data: AnthropicUsageResponse | undefined): data is AnthropicUsageResponse {
  if (!data || typeof data !== 'object') return false;

  const hasFiveHour = !!data.five_hour &&
    Number.isFinite(data.five_hour.utilization as number) &&
    typeof data.five_hour.resets_at === 'string';

  const hasSevenDay = !!data.seven_day &&
    Number.isFinite(data.seven_day.utilization as number) &&
    typeof data.seven_day.resets_at === 'string';

  return hasFiveHour || hasSevenDay;
}

function toPct(utilization: number | null | undefined): number {
  return clampPct(utilization ?? 0);
}

function formatIsoReset(value: string | null): string {
  if (!value) return '--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--';
  return formatDateShort(parsed);
}

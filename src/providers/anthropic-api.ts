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

type LimitBlock = {
  utilization?: number;
  resets_at?: string | null;
};

type RawUsageResponse = Record<string, any>;

const DESIGN_KEY_PATTERNS = ['seven_day_omelette', 'design_seven_day', 'designs_seven_day', 'design_weekly'];

export function extractDesignLimit(raw: RawUsageResponse): LimitBlock | null {
  for (const pattern of DESIGN_KEY_PATTERNS) {
    const block = raw[pattern];
    if (block && typeof block === 'object' && typeof block.utilization === 'number') {
      return block as LimitBlock;
    }
  }
  for (const key of Object.keys(raw)) {
    const kl = key.toLowerCase();
    if (!kl.includes('omelette') && !kl.includes('design')) continue;
    if (DESIGN_KEY_PATTERNS.includes(key)) continue;
    const block = raw[key];
    if (block && typeof block === 'object' && typeof block.utilization === 'number') {
      return block as LimitBlock;
    }
  }
  return null;
}

export function parseAnthropicUsage(raw: RawUsageResponse): ProviderUsageData {
  const fiveHour = raw['five_hour'] as LimitBlock | undefined;
  const sevenDay = raw['seven_day'] as LimitBlock | undefined;
  const designBlock = extractDesignLimit(raw);

  return {
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    color: '#C77DFF',
    sessionUsedPct: toPct(fiveHour?.utilization),
    weeklyUsedPct: toPct(sevenDay?.utilization),
    sessionResetDate: formatIsoReset(fiveHour?.resets_at ?? null),
    weeklyResetDate: formatIsoReset(sevenDay?.resets_at ?? null),
    designWeeklyUsedPct: toPct(designBlock?.utilization),
    designWeeklyResetDate: formatIsoReset(designBlock?.resets_at ?? null),
    scrapedAt: Date.now(),
  };
}

function isValidUsagePayload(raw: RawUsageResponse | undefined): boolean {
  if (!raw || typeof raw !== 'object') return false;

  const fiveHour = raw['five_hour'];
  const sevenDay = raw['seven_day'];

  const hasFiveHour = !!fiveHour &&
    typeof fiveHour === 'object' &&
    typeof fiveHour.utilization === 'number' &&
    typeof fiveHour.resets_at === 'string';

  const hasSevenDay = !!sevenDay &&
    typeof sevenDay === 'object' &&
    typeof sevenDay.utilization === 'number' &&
    typeof sevenDay.resets_at === 'string';

  if (hasFiveHour || hasSevenDay) return true;

  const design = extractDesignLimit(raw);
  if (design && typeof design.utilization === 'number') return true;

  return false;
}

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

  const usageRes = await httpRequest<RawUsageResponse>({
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
  if (!isValidUsagePayload(data)) {
    throw new ProviderScrapeError('payload_invalid', 'Anthropic usage payload invalid', true);
  }

  return parseAnthropicUsage(data!);
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

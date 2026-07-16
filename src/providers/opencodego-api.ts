import type { ProviderUsageData } from './types.js';
import type { ProviderSession } from './session.js';
import { httpRequest } from './http-client.js';
import { ProviderScrapeError } from './errors.js';
import { CHROME_UA } from './constants.js';
import type { ProviderUsageLimit } from './types.js';
import { clampPct } from './format-utils.js';
import { extractUsageLimits, legacyFieldsFromLimits } from './usage-limits.js';

type GoUsageWindow = {
  status?: string;
  resetInSec?: number;
  usagePercent?: number;
};

type GoSubscriptionData = {
  rollingUsage?: GoUsageWindow;
  weeklyUsage?: GoUsageWindow;
  monthlyUsage?: GoUsageWindow;
  [key: string]: GoUsageWindow | undefined;
};

export async function fetchOpenCodeGoUsageApi(
  session: ProviderSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderUsageData> {
  const workspaceId = await discoverWorkspaceId(session, timeoutMs, signal);

  const htmlRes = await httpRequest({
    url: `https://opencode.ai/workspace/${workspaceId}/go`,
    redirect: 'follow',
    timeoutMs,
    signal,
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'cookie': session.cookieHeader,
      'user-agent': CHROME_UA,
    },
  });

  if (htmlRes.status === 401 || htmlRes.status === 403) {
    throw new ProviderScrapeError(
      'unauthorized',
      `OpenCode Go page unauthorized (${htmlRes.status})`,
      false,
    );
  }
  if (htmlRes.status === 404) {
    throw new ProviderScrapeError(
      'endpoint_not_found',
      'OpenCode Go workspace page not found',
      false,
    );
  }
  if (!htmlRes.ok) {
    throw new ProviderScrapeError(
      'network_error',
      `OpenCode Go page request failed (${htmlRes.status})`,
      true,
    );
  }

  const html = htmlRes.rawText;
  if (!html || html.length < 100) {
    throw new ProviderScrapeError(
      'payload_invalid',
      'OpenCode Go page returned empty response',
      true,
    );
  }

  const loginCheck = html.toLowerCase();
  if (loginCheck.includes('/auth') && !loginCheck.includes('workspace')) {
    throw new ProviderScrapeError(
      'unauthorized',
      'OpenCode Go page redirected to auth',
      false,
    );
  }

  return parseOpenCodeGoUsageHtml(html);
}

export function parseOpenCodeGoUsageHtml(html: string): ProviderUsageData {
  const data = extractEmbeddedUsageData(html);
  const embedded = data ? mapUsageData(data) : undefined;
  const pageText = parseUsageFromPageText(html);
  const limits = mergeUsageLimits([...(embedded?.limits ?? []), ...(pageText.limits ?? [])]);
  if (limits.length === 0) {
    throw new ProviderScrapeError('payload_invalid', 'Could not parse OpenCode Go usage data', true);
  }
  return {
    providerId: 'opencodego',
    providerLabel: 'OpenCode Go',
    color: '#FF8C42',
    ...legacyFieldsFromLimits(limits),
    limits,
    scrapedAt: Date.now(),
  };
}

function mergeUsageLimits(limits: ProviderUsageLimit[]): ProviderUsageLimit[] {
  const merged: ProviderUsageLimit[] = [];
  for (const limit of limits) {
    const key = limit.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const duplicate = merged.find((entry) =>
      entry.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') === key
      && entry.usedPercent === limit.usedPercent,
    );
    if (!duplicate) merged.push(limit);
    else if (duplicate.resetDate === '--' && limit.resetDate !== '--') {
      duplicate.resetDate = limit.resetDate;
      duplicate.resetAt = limit.resetAt;
    }
  }
  return merged;
}

async function discoverWorkspaceId(
  session: ProviderSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await httpRequest({
    url: 'https://opencode.ai/auth',
    redirect: 'manual',
    timeoutMs,
    signal,
    headers: {
      'accept': 'text/html',
      'cookie': session.cookieHeader,
      'user-agent': CHROME_UA,
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new ProviderScrapeError(
      'unauthorized',
      `OpenCode Go auth unauthorized (${res.status})`,
      false,
    );
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers['location'] || '';
    const match = location.match(/\/workspace\/([^/?#]+)/);
    if (match?.[1]) return match[1];
  }

  if (res.status === 200 || (res.status >= 300 && res.status < 400)) {
    const fallbackRes = await httpRequest<{ id?: string }[]>({
      url: 'https://opencode.ai/api/workspaces',
      timeoutMs,
      signal,
      headers: {
        'accept': 'application/json',
        'cookie': session.cookieHeader,
        'user-agent': CHROME_UA,
      },
    });
    if (fallbackRes.status === 401 || fallbackRes.status === 403) {
      throw new ProviderScrapeError('unauthorized', `OpenCode Go workspaces unauthorized (${fallbackRes.status})`, false);
    }
    if (Array.isArray(fallbackRes.json) && fallbackRes.json.length > 0 && fallbackRes.json[0]?.id) {
      return fallbackRes.json[0].id;
    }
  }

  throw new ProviderScrapeError(
    'payload_invalid',
    'OpenCode Go workspace id not found',
    true,
  );
}

function extractEmbeddedUsageData(html: string): GoSubscriptionData | null {
  const result: GoSubscriptionData = {};
  const pattern = /["']?([A-Za-z][A-Za-z0-9_]*(?:Usage|Limit|Quota))["']?\s*:\s*\$R\[\d+\]\s*=\s*\{([^}]{0,1200})\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const usagePercent = match[2].match(/["']?usagePercent["']?\s*:\s*["']?([\d.]+)/)?.[1];
    if (!usagePercent) continue;
    const resetInSec = match[2].match(/["']?resetInSec["']?\s*:\s*["']?(\d+)/)?.[1];
    result[match[1]] = {
      status: 'ok',
      resetInSec: resetInSec ? Number.parseInt(resetInSec, 10) : undefined,
      usagePercent: Number.parseFloat(usagePercent),
    };
  }
  return Object.keys(result).length > 0 ? result : null;
}

function parseUsageFromPageText(html: string): ProviderUsageData {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const limits: ProviderUsageLimit[] = [];
  const pattern = /([A-Za-z0-9][A-Za-z0-9 -]{1,50}(?:Usage|Limit))\s*([\d.]+)\s*%/gi;
  const matches = [...text.matchAll(pattern)].map((match) => {
    const rawLabel = match[1].trim();
    const withoutPreviousReset = rawLabel
      .replace(/^.*\bResets?\s+in\s+\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?)\s+/i, '');
    const label = withoutPreviousReset.replace(/^.*\b(?:subscription|dashboard|overview|plan)\s+/i, '').trim();
    const labelOffset = Math.max(0, rawLabel.lastIndexOf(label));
    return { match, label, start: (match.index ?? 0) + labelOffset };
  });
  for (let index = 0; index < matches.length; index++) {
    const { match, label } = matches[index];
    const nextIndex = matches[index + 1]?.start ?? text.length;
    const following = text.slice((match.index ?? 0) + match[0].length, nextIndex);
    const reset = following.match(/Resets? in\s*(\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?))/i)?.[1]?.trim() ?? '--';
    const id = label;
    const usedPercent = clampPct(Number.parseFloat(match[2]));
    const duplicate = limits.find((limit) =>
      limit.label.toLowerCase() === label.toLowerCase() && limit.usedPercent === usedPercent,
    );
    if (!duplicate) limits.push({ id, label, usedPercent, resetDate: reset });
    else if (duplicate.resetDate === '--' && reset !== '--') duplicate.resetDate = reset;
  }

  return {
    providerId: 'opencodego',
    providerLabel: 'OpenCode Go',
    color: '#FF8C42',
    ...legacyFieldsFromLimits(limits),
    limits,
    scrapedAt: Date.now(),
  };
}

function mapUsageData(data: GoSubscriptionData): ProviderUsageData {
  const limits = extractUsageLimits(data, {
    aliases: { rollingUsage: 'Rolling usage', weeklyUsage: 'Weekly', monthlyUsage: 'Monthly' },
  });

  return {
    providerId: 'opencodego',
    providerLabel: 'OpenCode Go',
    color: '#FF8C42',
    ...legacyFieldsFromLimits(limits),
    limits,
    scrapedAt: Date.now(),
  };
}

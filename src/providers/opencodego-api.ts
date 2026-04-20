import type { ProviderUsageData } from './types.js';
import type { ProviderSession } from './session.js';
import { httpRequest } from './http-client.js';
import { ProviderScrapeError } from './errors.js';
import { CHROME_UA } from './constants.js';
import { clampPct, formatDateShort } from './format-utils.js';

type GoUsageWindow = {
  status?: string;
  resetInSec?: number;
  usagePercent?: number;
};

type GoSubscriptionData = {
  rollingUsage?: GoUsageWindow;
  weeklyUsage?: GoUsageWindow;
  monthlyUsage?: GoUsageWindow;
};

export async function fetchOpenCodeGoUsageApi(
  session: ProviderSession,
  timeoutMs: number,
): Promise<ProviderUsageData> {
  const workspaceId = await discoverWorkspaceId(session, timeoutMs);

  const htmlRes = await fetch(`https://opencode.ai/workspace/${workspaceId}/go`, {
    redirect: 'follow',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'cookie': session.cookieHeader,
      'user-agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(timeoutMs),
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

  const html = await htmlRes.text();
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

  const data = extractEmbeddedUsageData(html);
  if (!data) {
    return parseUsageFromPageText(html);
  }

  return mapUsageData(data);
}

async function discoverWorkspaceId(
  session: ProviderSession,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch('https://opencode.ai/auth', {
    redirect: 'manual',
    headers: {
      'accept': 'text/html',
      'cookie': session.cookieHeader,
      'user-agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 401 || res.status === 403) {
    throw new ProviderScrapeError(
      'unauthorized',
      `OpenCode Go auth unauthorized (${res.status})`,
      false,
    );
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    const match = location.match(/\/workspace\/([^/?#]+)/);
    if (match?.[1]) return match[1];
  }

  if (res.status === 200 || (res.status >= 300 && res.status < 400)) {
    const fallbackRes = await httpRequest<{ id?: string }[]>({
      url: 'https://opencode.ai/api/workspaces',
      timeoutMs,
      headers: {
        'accept': 'application/json',
        'cookie': session.cookieHeader,
        'user-agent': CHROME_UA,
      },
    });
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
  const rollingMatch = html.match(/rollingUsage:\$R\[\d+\]=\{.*?resetInSec:(\d+).*?usagePercent:([\d.]+)/);
  const weeklyMatch = html.match(/weeklyUsage:\$R\[\d+\]=\{.*?resetInSec:(\d+).*?usagePercent:([\d.]+)/);
  const monthlyMatch = html.match(/monthlyUsage:\$R\[\d+\]=\{.*?resetInSec:(\d+).*?usagePercent:([\d.]+)/);

  if (!rollingMatch && !weeklyMatch && !monthlyMatch) return null;

  return {
    rollingUsage: rollingMatch ? {
      status: 'ok',
      resetInSec: parseInt(rollingMatch[1], 10),
      usagePercent: parseFloat(rollingMatch[2]),
    } : undefined,
    weeklyUsage: weeklyMatch ? {
      status: 'ok',
      resetInSec: parseInt(weeklyMatch[1], 10),
      usagePercent: parseFloat(weeklyMatch[2]),
    } : undefined,
    monthlyUsage: monthlyMatch ? {
      status: 'ok',
      resetInSec: parseInt(monthlyMatch[1], 10),
      usagePercent: parseFloat(monthlyMatch[2]),
    } : undefined,
  };
}

function parseUsageFromPageText(html: string): ProviderUsageData {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  let sessionPct = 0;
  let weeklyPct = 0;
  let monthlyPct = 0;
  let sessionReset = '--';
  let weeklyReset = '--';
  let monthlyReset = '--';

  const rollingMatch = text.match(/Rolling Usage\s*([\d.]+)\s*%/i);
  const weeklyMatch = text.match(/Weekly Usage\s*([\d.]+)\s*%/i);
  const monthlyMatch = text.match(/Monthly Usage\s*([\d.]+)\s*%/i);

  if (rollingMatch) sessionPct = clampPct(parseFloat(rollingMatch[1]));
  if (weeklyMatch) weeklyPct = clampPct(parseFloat(weeklyMatch[1]));
  if (monthlyMatch) monthlyPct = clampPct(parseFloat(monthlyMatch[1]));

  const rollingResetMatch = text.match(/Rolling Usage[\s\S]*?Resets in\s*([\d]+\s*(?:hours?|minutes?|days?)(?:\s*[\d]+\s*(?:hours?|minutes?|days?))*)/i);
  const weeklyResetMatch = text.match(/Weekly Usage[\s\S]*?Resets in\s*([\d]+\s*(?:hours?|minutes?|days?)(?:\s*[\d]+\s*(?:hours?|minutes?|days?))*)/i);
  const monthlyResetMatch = text.match(/Monthly Usage[\s\S]*?Resets in\s*([\d]+\s*(?:hours?|minutes?|days?)(?:\s*[\d]+\s*(?:hours?|minutes?|days?))*)/i);

  if (rollingResetMatch) sessionReset = rollingResetMatch[1].trim();
  if (weeklyResetMatch) weeklyReset = weeklyResetMatch[1].trim();
  if (monthlyResetMatch) monthlyReset = monthlyResetMatch[1].trim();

  const parseFailed = sessionPct === 0 && weeklyPct === 0 && monthlyPct === 0 &&
    sessionReset === '--' && weeklyReset === '--' && monthlyReset === '--';

  return {
    providerId: 'opencodego',
    providerLabel: 'OpenCode Go',
    color: '#FF8C42',
    sessionUsedPct: sessionPct,
    weeklyUsedPct: weeklyPct,
    sessionResetDate: sessionReset,
    weeklyResetDate: weeklyReset,
    monthlyUsedPct: monthlyPct,
    monthlyResetDate: monthlyReset,
    scrapedAt: Date.now(),
    error: parseFailed ? 'Could not parse OpenCode Go usage from page HTML' : undefined,
  };
}

function mapUsageData(data: GoSubscriptionData): ProviderUsageData {
  const sessionUsedPct = clampPct(data.rollingUsage?.usagePercent ?? 0);
  const weeklyUsedPct = clampPct(data.weeklyUsage?.usagePercent ?? 0);
  const monthlyUsedPct = clampPct(data.monthlyUsage?.usagePercent ?? 0);

  const sessionResetDate = formatResetFromSec(data.rollingUsage?.resetInSec);
  const weeklyResetDate = formatResetFromSec(data.weeklyUsage?.resetInSec);
  const monthlyResetDate = formatResetFromSec(data.monthlyUsage?.resetInSec);

  const parseFailed = sessionUsedPct === 0 && weeklyUsedPct === 0 && monthlyUsedPct === 0 &&
    sessionResetDate === '--' && weeklyResetDate === '--' && monthlyResetDate === '--';

  return {
    providerId: 'opencodego',
    providerLabel: 'OpenCode Go',
    color: '#FF8C42',
    sessionUsedPct,
    weeklyUsedPct,
    sessionResetDate,
    weeklyResetDate,
    monthlyUsedPct,
    monthlyResetDate,
    scrapedAt: Date.now(),
    error: parseFailed ? 'Could not parse OpenCode Go usage data' : undefined,
  };
}

function formatResetFromSec(sec?: number): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '--';
  return formatDateShort(new Date(Date.now() + sec * 1000));
}

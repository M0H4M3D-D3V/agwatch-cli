import type { ProviderUsageData } from '../providers/types.js';
import { loadConfig } from '../config/agents.js';
import { getConnector } from '../providers/registry.js';
import { SUPPORTED_PROVIDERS } from '../config/providers.js';
import { getProviderRuntimeOptions } from '../providers/runtime-options.js';

function isDebugEnabled(): boolean {
  return getProviderRuntimeOptions().debug;
}

function debugLog(msg: string): void {
  if (!isDebugEnabled()) return;
  // Avoid corrupting Ink TUI layout in interactive terminals.
  if (process.stdout.isTTY && process.stdin.isTTY) return;
  process.stderr.write(`[providers-debug] ${msg}\n`);
}

function startupTimeoutMs(): number {
  return getProviderRuntimeOptions().startupTimeoutMs;
}

function manualTimeoutMs(): number {
  return getProviderRuntimeOptions().manualTimeoutMs;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const settledPromise = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

  const timeoutPromise = new Promise<{ ok: false; error: Error }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ ok: false, error: new Error(message) }), timeoutMs);
  });

  try {
    const outcome = await Promise.race([settledPromise, timeoutPromise]);
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function scrapeAllProviders(): Promise<ProviderUsageData[]> {
  return scrapeAllProvidersWithOptions({ allowVisibleFallback: true });
}

export async function scrapeAllProvidersWithOptions(options: { allowVisibleFallback: boolean }): Promise<ProviderUsageData[]> {
  const config = loadConfig();
  const userProviders = config.providers ?? [];
  const enabledProviders = userProviders.filter((up) => up.enabled);

  async function scrapeOne(providerId: string): Promise<ProviderUsageData | null> {
    const conn = getConnector(providerId);
    if (!conn) return null;

    const startedAt = Date.now();

    if (!conn.isConfigured()) {
      debugLog(`${conn.label} not configured (${Date.now() - startedAt}ms)`);
      return {
        providerId: conn.id,
        providerLabel: conn.label,
        color: conn.color,
        sessionUsedPct: 0,
        weeklyUsedPct: 0,
        sessionResetDate: '--',
        weeklyResetDate: '--',
        scrapedAt: Date.now(),
        error: 'Not configured',
      };
    }

    try {
      const timeoutMs = options.allowVisibleFallback ? manualTimeoutMs() : startupTimeoutMs();
      debugLog(`${conn.label} start (mode=${options.allowVisibleFallback ? 'manual' : 'startup'}, timeout=${timeoutMs}ms)`);
      const data = await withTimeout(
        conn.scrapeUsage({ allowVisibleFallback: options.allowVisibleFallback }),
        timeoutMs,
        `${conn.label} provider scrape timed out after ${timeoutMs / 1000}s`,
      );

      const ms = Date.now() - startedAt;
      if (data.error) {
        debugLog(`${conn.label} completed with error in ${ms}ms (source=${data.source ?? 'n/a'}, code=${data.errorCode ?? 'n/a'}): ${data.error}`);
      } else {
        const extra: string[] = [];
        if (data.monthlyUsedPct != null) extra.push(`mo=${data.monthlyUsedPct}%`);
        if (data.designWeeklyUsedPct != null) extra.push(`dwk=${data.designWeeklyUsedPct}%`);
        const extraStr = extra.length ? ` ${extra.join(' ')}` : '';
        debugLog(`${conn.label} completed in ${ms}ms (source=${data.source ?? 'n/a'}): 5h=${data.sessionUsedPct}% wk=${data.weeklyUsedPct}%${extraStr}`);
      }
      return data;
    } catch (err) {
      const ms = Date.now() - startedAt;
      const reason = err instanceof Error ? err.message : 'Scrape failed';
      debugLog(`${conn.label} threw in ${ms}ms: ${reason}`);
      return {
        providerId: conn.id,
        providerLabel: conn.label,
        color: conn.color,
        sessionUsedPct: 0,
        weeklyUsedPct: 0,
        sessionResetDate: '--',
        weeklyResetDate: '--',
        scrapedAt: Date.now(),
        error: reason,
      };
    }
  }

  const settled = await Promise.all(enabledProviders.map((up) => scrapeOne(up.id)));
  return settled.filter((r): r is ProviderUsageData => !!r);
}

export async function loadOrScrapeProviders(): Promise<ProviderUsageData[]> {
  const config = loadConfig();
  const userProviders = config.providers ?? [];
  if (userProviders.length === 0) return [];

  return scrapeAllProvidersWithOptions({ allowVisibleFallback: false });
}

export async function forceRefreshProviders(): Promise<ProviderUsageData[]> {
  return scrapeAllProvidersWithOptions({ allowVisibleFallback: true });
}

export async function refreshProvidersBackgroundOnly(): Promise<ProviderUsageData[]> {
  return scrapeAllProvidersWithOptions({ allowVisibleFallback: false });
}

export function getConfiguredProviders(): { id: string; label: string; color: string; configured: boolean }[] {
  const config = loadConfig();
  const userProviders = config.providers ?? [];
  const userSet = new Set(userProviders.map(p => p.id));
  return SUPPORTED_PROVIDERS.map(sp => ({
    id: sp.id,
    label: sp.label,
    color: sp.color,
    configured: userSet.has(sp.id),
  }));
}

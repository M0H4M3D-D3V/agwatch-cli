import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderConnector, ProviderScrapeOptions, ProviderUsageData } from './types.js';
import { getSupportedProvider } from '../config/providers.js';
import { hasCookies, deleteCookies, authenticate, createScrapePageForProvider } from './browser.js';
import { loadProviderSession } from './session.js';
import { fetchZAIUsageApi, parseZAIUsage } from './zai-api.js';
import { getFallbackMode, shouldFallbackToBrowser } from './fallback-policy.js';
import { ProviderScrapeError, toProviderScrapeError } from './errors.js';
import { recordScrapeMetric } from './metrics.js';
import { extractUsageLimits, legacyFieldsFromLimits } from './usage-limits.js';
import { extractUsageLimitsFromPage } from './dom-usage-limits.js';

type ZaiUsageApiShape = {
  five_hour?: {
    used?: number;
    total?: number;
    percent?: number;
    reset_at?: string | number | null;
    reset_after_seconds?: number | null;
  };
  seven_day?: {
    used?: number;
    total?: number;
    percent?: number;
    reset_at?: string | number | null;
    reset_after_seconds?: number | null;
  };
  [k: string]: unknown;
};

export class ZAIConnector implements ProviderConnector {
  readonly id = 'zai';
  readonly label = 'Z.AI';
  readonly color = '#4A90D9';

  private get def() {
    return getSupportedProvider('zai')!;
  }

  isConfigured(): boolean {
    return hasCookies(this.id);
  }

  async authenticate(onStatus?: (msg: string) => void, signal?: AbortSignal): Promise<void> {
    const ok = await authenticate(
      this.id,
      this.def.authUrl,
      this.def.authSuccessPattern,
      this.def.usageUrl,
      onStatus,
      signal,
    );
    if (!ok) throw new Error('Authentication failed or timed out');
  }

  async scrapeUsage(options?: ProviderScrapeOptions): Promise<ProviderUsageData> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const mode = options?.allowVisibleFallback ? 'manual' : 'startup';
    const apiTimeout = options?.allowVisibleFallback ? 18_000 : 12_000;
    const session = loadProviderSession(this.id);

    if (!session) {
      const result = this.errorResult(new ProviderScrapeError('not_configured', 'Not configured', false), 'api', startedAt);
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: result.durationMs ?? 0, success: false, errorCode: result.errorCode, at: Date.now() });
      return result;
    }

    try {
      const data = await fetchZAIUsageApi(session, apiTimeout, signal);
      signal?.throwIfAborted();
      data.source = 'api';
      data.durationMs = Date.now() - startedAt;
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: data.durationMs, success: true, at: Date.now() });
      return data;
    } catch (err) {
      signal?.throwIfAborted();
      const mapped = toProviderScrapeError(err);
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: Date.now() - startedAt, success: false, errorCode: mapped.code, at: Date.now() });

      if (shouldFallbackToBrowser(mapped.code, getFallbackMode())) {
        const fbStart = Date.now();
        const fastMode = options?.allowVisibleFallback === false;
        let fb: ProviderUsageData;
        try {
          fb = await this.scrapeUsageBrowserFallback(fastMode, signal);
          signal?.throwIfAborted();
        } catch (fallbackError) {
          if (mapped.code === 'unauthorized') deleteCookies(this.id);
          throw fallbackError;
        }
        fb.source = 'browser-fallback';
        fb.durationMs = Date.now() - fbStart;
        if (fb.error) {
          fb.errorCode = fb.errorCode ?? 'unknown';
          if (mapped.code === 'unauthorized' || fb.errorCode === 'unauthorized') deleteCookies(this.id);
          recordScrapeMetric({ providerId: this.id, mode, source: 'browser-fallback', durationMs: fb.durationMs, success: false, errorCode: fb.errorCode, at: Date.now() });
        } else {
          recordScrapeMetric({ providerId: this.id, mode, source: 'browser-fallback', durationMs: fb.durationMs, success: true, at: Date.now() });
        }
        return fb;
      }

      if (mapped.code === 'unauthorized') deleteCookies(this.id);
      return this.errorResult(mapped, 'api', startedAt);
    }
  }

  private async scrapeUsageBrowserFallback(fastMode: boolean, signal?: AbortSignal): Promise<ProviderUsageData> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any | null = null;
    try {
      page = await createScrapePageForProvider(this.id, signal);
      const apiResult = await this.tryApiIntercept(page, fastMode, signal);
      signal?.throwIfAborted();
      if (apiResult) return apiResult;

      if (fastMode) {
        return this.errorResult(new ProviderScrapeError('endpoint_not_found', 'Z.AI usage API not detected in fast startup mode', true), 'browser-fallback');
      }

      return await this.parseDomUsage(page, signal);
    } catch (err) {
      signal?.throwIfAborted();
      return this.errorResult(toProviderScrapeError(err), 'browser-fallback');
    } finally {
      if (page) { try { await page.close(); } catch { /* ignore */ } }
    }
  }

  removeConfig(): void {
    deleteCookies(this.id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async tryApiIntercept(page: any, fastMode: boolean, signal?: AbortSignal): Promise<ProviderUsageData | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: Array<{ body: string; url: string }> = [];

    const pending = new Set<Promise<void>>();
    const onResponse = (res: { url: () => string; status: () => number; text: () => Promise<string> }) => {
      const task = (async () => {
        try {
          const url = res.url();
          const pathname = new URL(url).pathname;
          if (!/coding-plan|usage|quota/i.test(pathname)) return;
          if (res.status() < 200 || res.status() >= 300) return;
          const body = await res.text();
          if (signal?.aborted) return;
          candidates.push({ body, url });
        } catch { /* ignore */ }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    };

    page.on('response', onResponse);

    try {
      await page.goto(this.def.usageUrl, { waitUntil: 'domcontentloaded', timeout: fastMode ? 12_000 : 20_000, signal });
      await delay(fastMode ? 1_800 : 4_000, undefined, { signal });
    } finally {
      page.off('response', onResponse);
      await Promise.allSettled([...pending]);
    }

    let bestResult: ProviderUsageData | null = null;
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c.body) as ZaiUsageApiShape;
        if (this.looksLikeUsageData(parsed)) {
          const result = this.mapApiResult(parsed);
          if ((result.limits?.length ?? 0) > (bestResult?.limits?.length ?? 0)) bestResult = result;
        }
      } catch { /* try next */ }
    }

    return bestResult;
  }

  private looksLikeUsageData(data: ZaiUsageApiShape): boolean {
    return extractUsageLimits(data, {
      aliases: { five_hour: '5 hours', seven_day: '7 days' },
    }).length > 0;
  }

  private mapApiResult(data: ZaiUsageApiShape): ProviderUsageData {
    return parseZAIUsage(data);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseDomUsage(page: any, signal?: AbortSignal): Promise<ProviderUsageData> {
    try {
      await page.waitForSelector('body', { timeout: 4_000, signal });
      await delay(1_200, undefined, { signal });
      const limits = await extractUsageLimitsFromPage(page, signal);
      if (limits.length === 0) {
        return this.errorResult(new ProviderScrapeError('payload_invalid', 'No usage limits were found on the Z.AI usage page', true), 'browser-fallback');
      }
      return {
        providerId: this.id,
        providerLabel: this.label,
        color: this.color,
        ...legacyFieldsFromLimits(limits),
        limits,
        scrapedAt: Date.now(),
      };
    } catch (err) {
      signal?.throwIfAborted();
      return this.errorResult(toProviderScrapeError(err), 'browser-fallback');
    }
  }

  private errorResult(err: unknown, source: 'api' | 'browser-fallback', startedAt?: number): ProviderUsageData {
    const mapped = toProviderScrapeError(err);
    return {
      providerId: this.id,
      providerLabel: this.label,
      color: this.color,
      sessionUsedPct: 0,
      weeklyUsedPct: 0,
      sessionResetDate: '--',
      weeklyResetDate: '--',
      limits: [],
      scrapedAt: Date.now(),
      error: mapped.message,
      errorCode: mapped.code,
      source,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    };
  }
}

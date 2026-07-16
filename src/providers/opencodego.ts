import type { ProviderConnector, ProviderScrapeOptions, ProviderUsageData } from './types.js';
import { getSupportedProvider } from '../config/providers.js';
import { hasCookies, deleteCookies, authenticate, createScrapePageForProvider } from './browser.js';
import { loadProviderSession } from './session.js';
import { fetchOpenCodeGoUsageApi } from './opencodego-api.js';
import { getFallbackMode, shouldFallbackToBrowser } from './fallback-policy.js';
import { ProviderScrapeError, toProviderScrapeError } from './errors.js';
import { recordScrapeMetric } from './metrics.js';
import { legacyFieldsFromLimits } from './usage-limits.js';
import { extractUsageLimitsFromPage } from './dom-usage-limits.js';

export class OpenCodeGoConnector implements ProviderConnector {
  readonly id = 'opencodego';
  readonly label = 'OpenCode Go';
  readonly color = '#FF8C42';

  private get def() {
    return getSupportedProvider('opencodego')!;
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
      const result = this.errorRow(new ProviderScrapeError('not_configured', 'Not configured', false), 'api', startedAt);
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: result.durationMs ?? 0, success: false, errorCode: result.errorCode, at: Date.now() });
      return result;
    }

    try {
      const data = await fetchOpenCodeGoUsageApi(session, apiTimeout, signal);
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
        let fb: ProviderUsageData;
        try {
          fb = await this.scrapeUsageBrowserFallback(signal);
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
      return this.errorRow(mapped, 'api', startedAt);
    }
  }

  removeConfig(): void {
    deleteCookies(this.id);
  }

  private async scrapeUsageBrowserFallback(signal?: AbortSignal): Promise<ProviderUsageData> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any | null = null;
    try {
      page = await createScrapePageForProvider(this.id, signal);

      await page.goto('https://opencode.ai/auth', { waitUntil: 'networkidle2', timeout: 15000, signal });
      const authRedirectUrl = page.url();
      const wsMatch = authRedirectUrl.match(/\/workspace\/([^/?#]+)/);
      if (!wsMatch?.[1]) {
        throw new ProviderScrapeError('unauthorized', 'Could not discover workspace ID from auth redirect', false);
      }
      const workspaceId = wsMatch[1];

      await page.goto(`https://opencode.ai/workspace/${workspaceId}/go`, { waitUntil: 'networkidle2', timeout: 15000, signal });

      return await this.parseDomUsage(page, signal);
    } catch (err) {
      signal?.throwIfAborted();
      return this.errorRow(toProviderScrapeError(err), 'browser-fallback');
    } finally {
      if (page) { try { await page.close(); } catch { /* ignore */ } }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseDomUsage(page: any, signal?: AbortSignal): Promise<ProviderUsageData> {
    try {
      const limits = await extractUsageLimitsFromPage(page, signal);
      if (limits.length === 0) {
        return this.errorRow(
          new ProviderScrapeError('payload_invalid', 'No usage limits were found on the OpenCode Go page', true),
          'browser-fallback',
        );
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
      return this.errorRow(toProviderScrapeError(err), 'browser-fallback');
    }
  }

  private errorRow(err: unknown, source: 'api' | 'browser-fallback', startedAt?: number): ProviderUsageData {
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

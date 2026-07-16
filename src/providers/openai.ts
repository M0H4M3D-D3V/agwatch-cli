import type { ProviderConnector, ProviderScrapeOptions, ProviderUsageData } from './types.js';
import { getSupportedProvider } from '../config/providers.js';
import { hasCookies, deleteCookies, authenticate, createScrapePageForProvider } from './browser.js';
import { loadProviderSession } from './session.js';
import { fetchOpenAIUsageApi, parseOpenAIUsage } from './openai-api.js';
import { getFallbackMode, shouldFallbackToBrowser } from './fallback-policy.js';
import { ProviderScrapeError, toProviderScrapeError } from './errors.js';
import { recordScrapeMetric } from './metrics.js';
import { extractUsageLimits } from './usage-limits.js';

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

export class OpenAIConnector implements ProviderConnector {
  readonly id = 'openai';
  readonly label = 'OpenAI';
  readonly color = '#5BE0F5';

  private get def() {
    return getSupportedProvider('openai')!;
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
      const data = await fetchOpenAIUsageApi(session, apiTimeout, signal);
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
          fb = await this.scrapeUsageHeadlessApi(signal);
          signal?.throwIfAborted();
        } catch (fallbackError) {
          if (mapped.code === 'unauthorized') deleteCookies(this.id);
          throw fallbackError;
        }
        fb.source = 'browser-fallback';
        fb.durationMs = Date.now() - fbStart;
        if (fb.error) {
          fb.errorCode ??= mapped.code;
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

  private async scrapeUsageHeadlessApi(signal?: AbortSignal): Promise<ProviderUsageData> {
    // We wait for the app's own wham/usage response, but with strict matching
    // and payload validation so we never capture sibling endpoints such as
    // /wham/usage/credit-usage-events.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any | null = null;
    try {
      page = await createScrapePageForProvider(this.id, signal);

      const usageJsonPromise = new Promise<WhamUsageResponse>((resolve, reject) => {
        let done = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const finish = (cb: () => void): void => {
          if (done) return;
          done = true;
          if (timeout) clearTimeout(timeout);
          page.off('response', onResponse);
          signal?.removeEventListener('abort', onAbort);
          cb();
        };

        const onAbort = () => finish(() => reject(signal?.reason));

        const onResponse = async (res: { url: () => string; status: () => number; text: () => Promise<string> }) => {
          let pathname = '';
          try {
            pathname = new URL(res.url()).pathname;
          } catch {
            return;
          }

          // (1) Exact endpoint only.
          if (pathname !== '/backend-api/wham/usage') {
            return;
          }

          const status = res.status();
          if (status === 401 || status === 403) {
            finish(() => reject(new Error(`wham usage unauthorized (${status})`)));
            return;
          }
          if (status < 200 || status >= 300) {
            return;
          }

          try {
            const raw = await res.text();
            if (signal?.aborted) return onAbort();
            const parsed = JSON.parse(raw) as WhamUsageResponse;
            // (2) Accept only valid usage payload shape.
            if (!this.isValidWhamUsageResponse(parsed)) {
              return;
            }
            finish(() => resolve(parsed));
          } catch {
            // Keep listening until timeout or valid payload.
          }
        };

        timeout = setTimeout(() => {
          finish(() => reject(new Error('Timed out waiting for valid wham usage response')));
        }, 60_000);

        // (3) Keep listener active until valid payload or timeout.
        page.on('response', onResponse);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });

      // Prevent unhandled rejection if caller exits early (e.g. outer timeout).
      void usageJsonPromise.catch(() => {});

      // (5) Faster readiness strategy than networkidle2.
      await page.goto(this.def.usageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000, signal });

      const usageJson = await usageJsonPromise;
      signal?.throwIfAborted();

      return this.parseUsageFromApi(usageJson);
    } catch (err) {
      signal?.throwIfAborted();
      return this.errorRow(toProviderScrapeError(err), 'browser-fallback');
    } finally {
      if (page) { try { await page.close(); } catch { /* ignore */ } }
    }
  }

  private errorRow(err: ProviderScrapeError, source: 'api' | 'browser-fallback', startedAt?: number): ProviderUsageData {
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
      error: err.message,
      errorCode: err.code,
      source,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    };
  }

  private parseUsageFromApi(data: WhamUsageResponse): ProviderUsageData {
    return parseOpenAIUsage(data);
  }

  private isValidWhamUsageResponse(data: WhamUsageResponse): boolean {
    return extractUsageLimits(data, { aliases: { primary_window: 'Primary window', secondary_window: 'Secondary window' } }).length > 0;
  }

  removeConfig(): void {
    deleteCookies(this.id);
  }
}

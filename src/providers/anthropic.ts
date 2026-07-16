import type { ProviderConnector, ProviderScrapeOptions, ProviderUsageData } from './types.js';
import { getSupportedProvider } from '../config/providers.js';
import { hasCookies, deleteCookies, authenticate, createScrapePageForProvider } from './browser.js';
import { loadProviderSession } from './session.js';
import { fetchAnthropicUsageApi, parseAnthropicUsage } from './anthropic-api.js';
import { getFallbackMode, shouldFallbackToBrowser } from './fallback-policy.js';
import { ProviderScrapeError, toProviderScrapeError } from './errors.js';
import { recordScrapeMetric } from './metrics.js';
import { extractUsageLimits } from './usage-limits.js';

type RawUsageResponse = Record<string, any>;

export class AnthropicConnector implements ProviderConnector {
  readonly id = 'anthropic';
  readonly label = 'Anthropic';
  readonly color = '#C77DFF';

  private get def() {
    return getSupportedProvider('anthropic')!;
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
      const data = await fetchAnthropicUsageApi(session, apiTimeout, signal);
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
          throw fallbackError;
        }
        fb.source = 'browser-fallback';
        fb.durationMs = Date.now() - fbStart;
        if (fb.error) {
          fb.errorCode ??= mapped.code;
          if (fb.errorCode === 'unauthorized') deleteCookies(this.id);
          recordScrapeMetric({ providerId: this.id, mode, source: 'browser-fallback', durationMs: fb.durationMs, success: false, errorCode: fb.errorCode, at: Date.now() });
        } else {
          recordScrapeMetric({ providerId: this.id, mode, source: 'browser-fallback', durationMs: fb.durationMs, success: true, at: Date.now() });
        }
        return fb;
      }

      return this.errorRow(mapped, 'api', startedAt);
    }
  }

  private async scrapeUsageHeadlessApi(signal?: AbortSignal): Promise<ProviderUsageData> {
    let page: any | null = null;
    try {
      page = await createScrapePageForProvider(this.id, signal);

      const usageJsonPromise = new Promise<RawUsageResponse>((resolve, reject) => {
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

          if (!/^\/api\/organizations\/[^/]+\/usage$/.test(pathname)) {
            return;
          }

          const status = res.status();
          if (status === 401 || status === 403) {
            finish(() => reject(new Error(`Anthropic usage unauthorized (${status})`)));
            return;
          }
          if (status < 200 || status >= 300) {
            return;
          }

          try {
            const raw = await res.text();
            if (signal?.aborted) return onAbort();
            const parsed = JSON.parse(raw) as RawUsageResponse;
            if (!this.isValidRawUsage(parsed)) {
              return;
            }
            finish(() => resolve(parsed));
          } catch {
            // keep listening until timeout or valid payload
          }
        };

        timeout = setTimeout(() => {
          finish(() => reject(new Error('Timed out waiting for Anthropic usage response')));
        }, 60_000);

        page.on('response', onResponse);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });

      // Prevent unhandled rejection if caller exits early (e.g. outer timeout).
      void usageJsonPromise.catch(() => {});

      await page.goto(this.def.usageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000, signal });
      const data = await usageJsonPromise;
      signal?.throwIfAborted();
      if (!this.isValidRawUsage(data)) {
        throw new Error('Anthropic usage API returned invalid payload shape');
      }

      const result = parseAnthropicUsage(data);
      return result;
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

  private isValidRawUsage(data: RawUsageResponse | undefined): boolean {
    return extractUsageLimits(data, { aliases: { five_hour: '5 hours', seven_day: '7 days' } }).length > 0;
  }

  removeConfig(): void {
    deleteCookies(this.id);
  }
}

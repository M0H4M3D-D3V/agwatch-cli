import type { ProviderConnector, ProviderUsageData } from './types.js';
import { getSupportedProvider } from '../config/providers.js';
import { hasCookies, deleteCookies, authenticate, createScrapePageForProvider } from './browser.js';
import { loadProviderSession } from './session.js';
import { fetchOpenAIUsageApi } from './openai-api.js';
import { getFallbackMode, shouldFallbackToBrowser } from './fallback-policy.js';
import { ProviderScrapeError, toProviderScrapeError } from './errors.js';
import { recordScrapeMetric } from './metrics.js';
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

  async authenticate(onStatus?: (msg: string) => void): Promise<void> {
    const ok = await authenticate(
      this.id,
      this.def.authUrl,
      this.def.authSuccessPattern,
      this.def.usageUrl,
      onStatus,
    );
    if (!ok) throw new Error('Authentication failed or timed out');
  }

  async scrapeUsage(_options?: { allowVisibleFallback?: boolean }): Promise<ProviderUsageData> {
    const startedAt = Date.now();
    const mode = _options?.allowVisibleFallback ? 'manual' : 'startup';
    const apiTimeout = _options?.allowVisibleFallback ? 18_000 : 12_000;
    const session = loadProviderSession(this.id);

    if (!session) {
      const result = this.errorRow(new ProviderScrapeError('not_configured', 'Not configured', false), 'api', startedAt);
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: result.durationMs ?? 0, success: false, errorCode: result.errorCode, at: Date.now() });
      return result;
    }

    try {
      const data = await fetchOpenAIUsageApi(session, apiTimeout);
      data.source = 'api';
      data.durationMs = Date.now() - startedAt;
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: data.durationMs, success: true, at: Date.now() });
      return data;
    } catch (err) {
      const mapped = toProviderScrapeError(err);
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: Date.now() - startedAt, success: false, errorCode: mapped.code, at: Date.now() });

      if (shouldFallbackToBrowser(mapped.code, getFallbackMode())) {
        const fbStart = Date.now();
        const fb = await this.scrapeUsageHeadlessApi();
        fb.source = 'browser-fallback';
        fb.durationMs = Date.now() - fbStart;
        if (fb.error) {
          fb.errorCode = 'unknown';
          recordScrapeMetric({ providerId: this.id, mode, source: 'browser-fallback', durationMs: fb.durationMs, success: false, errorCode: fb.errorCode, at: Date.now() });
        } else {
          recordScrapeMetric({ providerId: this.id, mode, source: 'browser-fallback', durationMs: fb.durationMs, success: true, at: Date.now() });
        }
        return fb;
      }

      return this.errorRow(mapped, 'api', startedAt);
    }
  }

  private async scrapeUsageHeadlessApi(): Promise<ProviderUsageData> {
    // We wait for the app's own wham/usage response, but with strict matching
    // and payload validation so we never capture sibling endpoints such as
    // /wham/usage/credit-usage-events.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any | null = null;
    try {
      page = await createScrapePageForProvider(this.id);

      const usageJsonPromise = new Promise<WhamUsageResponse>((resolve, reject) => {
        let done = false;

        const finish = (cb: () => void): void => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          page.off('response', onResponse);
          cb();
        };

        const timeout = setTimeout(() => {
          finish(() => reject(new Error('Timed out waiting for valid wham usage response')));
        }, 60_000);

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

        // (3) Keep listener active until valid payload or timeout.
        page.on('response', onResponse);
      });

      // Prevent unhandled rejection if caller exits early (e.g. outer timeout).
      void usageJsonPromise.catch(() => {});

      // (5) Faster readiness strategy than networkidle2.
      await page.goto(this.def.usageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      const usageJson = await usageJsonPromise;

      return this.parseUsageFromApi(usageJson);
    } catch (err) {
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
      scrapedAt: Date.now(),
      error: err.message,
      errorCode: err.code,
      source,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    };
  }

  private parseUsageFromApi(data: WhamUsageResponse): ProviderUsageData {
    const primary = data.rate_limit?.primary_window;
    const secondary = data.rate_limit?.secondary_window;

    const sessionPct = this.clampPct(primary?.used_percent ?? 0);
    const weeklyPct = this.clampPct(secondary?.used_percent ?? 0);

    const sessionReset = this.formatReset(primary?.reset_at, primary?.reset_after_seconds);
    const weeklyReset = this.formatReset(secondary?.reset_at, secondary?.reset_after_seconds);

    const parseFailed = sessionPct === 0 && weeklyPct === 0 && sessionReset === '--' && weeklyReset === '--';

    return {
      providerId: this.id,
      providerLabel: this.label,
      color: this.color,
      sessionUsedPct: sessionPct,
      weeklyUsedPct: weeklyPct,
      sessionResetDate: sessionReset,
      weeklyResetDate: weeklyReset,
      scrapedAt: Date.now(),
      error: parseFailed ? 'Could not parse wham usage API response' : undefined,
    };
  }

  private isValidWhamUsageResponse(data: WhamUsageResponse): boolean {
    if (!data || typeof data !== 'object') return false;
    const rl = data.rate_limit;
    if (!rl || typeof rl !== 'object') return false;

    const p = rl.primary_window;
    const s = rl.secondary_window;
    const hasPrimary = !!p &&
      typeof p === 'object' &&
      Number.isFinite(p.used_percent as number) &&
      (Number.isFinite(p.reset_at as number) || Number.isFinite(p.reset_after_seconds as number));

    const hasSecondary = !!s &&
      typeof s === 'object' &&
      Number.isFinite(s.used_percent as number) &&
      (Number.isFinite(s.reset_at as number) || Number.isFinite(s.reset_after_seconds as number));

    return hasPrimary || hasSecondary;
  }

  private clampPct(value: number): number {
    return clampPct(value);
  }

  private formatReset(resetAtEpochSec?: number, resetAfterSec?: number): string {
    if (Number.isFinite(resetAtEpochSec as number) && (resetAtEpochSec as number) > 0) {
      return formatDateShort(new Date((resetAtEpochSec as number) * 1000));
    }
    if (Number.isFinite(resetAfterSec as number) && (resetAfterSec as number) > 0) {
      return formatDateShort(new Date(Date.now() + (resetAfterSec as number) * 1000));
    }
    return '--';
  }

  removeConfig(): void {
    deleteCookies(this.id);
  }
}

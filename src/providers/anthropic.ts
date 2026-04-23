import type { ProviderConnector, ProviderUsageData } from './types.js';
import { getSupportedProvider } from '../config/providers.js';
import { hasCookies, deleteCookies, authenticate, createScrapePageForProvider } from './browser.js';
import { loadProviderSession } from './session.js';
import { fetchAnthropicUsageApi, extractDesignLimit, parseAnthropicUsage } from './anthropic-api.js';
import { getFallbackMode, shouldFallbackToBrowser } from './fallback-policy.js';
import { ProviderScrapeError, toProviderScrapeError } from './errors.js';
import { recordScrapeMetric } from './metrics.js';

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
      const data = await fetchAnthropicUsageApi(session, apiTimeout);
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
    let page: any | null = null;
    try {
      page = await createScrapePageForProvider(this.id);

      const usageJsonPromise = new Promise<RawUsageResponse>((resolve, reject) => {
        let done = false;

        const finish = (cb: () => void): void => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          page.off('response', onResponse);
          cb();
        };

        const timeout = setTimeout(() => {
          finish(() => reject(new Error('Timed out waiting for Anthropic usage response')));
        }, 60_000);

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
            const parsed = JSON.parse(raw) as RawUsageResponse;
            if (!this.isValidRawUsage(parsed)) {
              return;
            }
            finish(() => resolve(parsed));
          } catch {
            // keep listening until timeout or valid payload
          }
        };

        page.on('response', onResponse);
      });

      // Prevent unhandled rejection if caller exits early (e.g. outer timeout).
      void usageJsonPromise.catch(() => {});

      await page.goto(this.def.usageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const data = await usageJsonPromise;
      if (!this.isValidRawUsage(data)) {
        throw new Error('Anthropic usage API returned invalid payload shape');
      }

      const result = parseAnthropicUsage(data);
      const hasDesignBlock = extractDesignLimit(data) != null;

      const hasPrimaryUsage = result.sessionUsedPct !== 0 || result.weeklyUsedPct !== 0;
      const hasDesignUsage = hasDesignBlock || result.designWeeklyUsedPct !== 0;
      const hasAnyUsage = hasPrimaryUsage || hasDesignUsage;

      const hasPrimaryReset = result.sessionResetDate !== '--' || result.weeklyResetDate !== '--';
      const hasDesignReset = hasDesignBlock || result.designWeeklyResetDate !== '--';
      const hasAnyReset = hasPrimaryReset || hasDesignReset;

      const parseFailed = !hasAnyUsage && !hasAnyReset;

      if (parseFailed) {
        result.error = 'Could not parse Anthropic usage API response';
      }
      return result;
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
      designWeeklyUsedPct: 0,
      designWeeklyResetDate: '--',
      scrapedAt: Date.now(),
      error: err.message,
      errorCode: err.code,
      source,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    };
  }

  private isValidRawUsage(data: RawUsageResponse | undefined): boolean {
    if (!data || typeof data !== 'object') return false;

    const fiveHour = data['five_hour'];
    const sevenDay = data['seven_day'];

    const hasFiveHour = !!fiveHour &&
      typeof fiveHour === 'object' &&
      typeof fiveHour.utilization === 'number' &&
      typeof fiveHour.resets_at === 'string';

    const hasSevenDay = !!sevenDay &&
      typeof sevenDay === 'object' &&
      typeof sevenDay.utilization === 'number' &&
      typeof sevenDay.resets_at === 'string';

    if (hasFiveHour || hasSevenDay) return true;

    const design = extractDesignLimit(data);
    if (design && typeof design.utilization === 'number') return true;

    return false;
  }

  removeConfig(): void {
    deleteCookies(this.id);
  }
}

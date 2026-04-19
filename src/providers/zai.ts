import type { ProviderConnector, ProviderUsageData } from './types.js';
import { getSupportedProvider } from '../config/providers.js';
import { hasCookies, deleteCookies, authenticate, createScrapePageForProvider } from './browser.js';
import { loadProviderSession } from './session.js';
import { fetchZAIUsageApi } from './zai-api.js';
import { getFallbackMode, shouldFallbackToBrowser } from './fallback-policy.js';
import { ProviderScrapeError, toProviderScrapeError } from './errors.js';
import { recordScrapeMetric } from './metrics.js';
import { clampPct, formatDateShort } from './format-utils.js';

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

  async authenticate(onStatus?: (msg: string) => void): Promise<void> {
    const ok = await authenticate(
      this.id,
      this.def.authUrl,
      this.def.authSuccessPattern,
      undefined,
      onStatus,
    );
    if (!ok) throw new Error('Authentication failed or timed out');
  }

  async scrapeUsage(options?: { allowVisibleFallback?: boolean }): Promise<ProviderUsageData> {
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
      const data = await fetchZAIUsageApi(session, apiTimeout);
      data.source = 'api';
      data.durationMs = Date.now() - startedAt;
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: data.durationMs, success: true, at: Date.now() });
      return data;
    } catch (err) {
      const mapped = toProviderScrapeError(err);
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: Date.now() - startedAt, success: false, errorCode: mapped.code, at: Date.now() });

      if (shouldFallbackToBrowser(mapped.code, getFallbackMode())) {
        const fbStart = Date.now();
        const fastMode = options?.allowVisibleFallback === false;
        const fb = await this.scrapeUsageBrowserFallback(fastMode);
        fb.source = 'browser-fallback';
        fb.durationMs = Date.now() - fbStart;
        if (fb.error) {
          fb.errorCode = fb.errorCode ?? 'unknown';
          recordScrapeMetric({ providerId: this.id, mode, source: 'browser-fallback', durationMs: fb.durationMs, success: false, errorCode: fb.errorCode, at: Date.now() });
        } else {
          recordScrapeMetric({ providerId: this.id, mode, source: 'browser-fallback', durationMs: fb.durationMs, success: true, at: Date.now() });
        }
        return fb;
      }

      return this.errorResult(mapped, 'api', startedAt);
    }
  }

  private async scrapeUsageBrowserFallback(fastMode: boolean): Promise<ProviderUsageData> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any | null = null;
    try {
      page = await createScrapePageForProvider(this.id);
      const apiResult = await this.tryApiIntercept(page, fastMode);
      if (apiResult) return apiResult;

      if (fastMode) {
        return this.errorResult(new ProviderScrapeError('endpoint_not_found', 'Z.AI usage API not detected in fast startup mode', true), 'browser-fallback');
      }

      return await this.parseDomUsage(page);
    } catch (err) {
      return this.errorResult(toProviderScrapeError(err), 'browser-fallback');
    } finally {
      if (page) { try { await page.close(); } catch { /* ignore */ } }
    }
  }

  removeConfig(): void {
    deleteCookies(this.id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async tryApiIntercept(page: any, fastMode: boolean): Promise<ProviderUsageData | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: Array<{ body: string; url: string }> = [];

    const onResponse = async (res: { url: () => string; status: () => number; text: () => Promise<string> }) => {
      try {
        const url = res.url();
        const pathname = new URL(url).pathname;
        if (!/coding-plan|usage|quota/i.test(pathname)) return;
        if (res.status() < 200 || res.status() >= 300) return;
        const body = await res.text();
        candidates.push({ body, url });
      } catch { /* ignore */ }
    };

    page.on('response', onResponse);

    try {
      await page.goto(this.def.usageUrl, { waitUntil: 'domcontentloaded', timeout: fastMode ? 12_000 : 20_000 });
      await new Promise(r => setTimeout(r, fastMode ? 1_800 : 4_000));
    } finally {
      page.off('response', onResponse);
    }

    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c.body) as ZaiUsageApiShape;
        if (this.looksLikeUsageData(parsed)) {
          return this.mapApiResult(parsed);
        }
      } catch { /* try next */ }
    }

    return null;
  }

  private looksLikeUsageData(data: ZaiUsageApiShape): boolean {
    if (!data || typeof data !== 'object') return false;
    const fh = data.five_hour;
    const sd = data.seven_day;
    const hasFh = !!fh && typeof fh === 'object' && (typeof fh.percent === 'number' || (typeof fh.used === 'number' && typeof fh.total === 'number'));
    const hasSd = !!sd && typeof sd === 'object' && (typeof sd.percent === 'number' || (typeof sd.used === 'number' && typeof sd.total === 'number'));
    return hasFh || hasSd;
  }

  private mapApiResult(data: ZaiUsageApiShape): ProviderUsageData {
    const fh = data.five_hour;
    const sd = data.seven_day;

    const sessionPct = fh?.percent != null
      ? this.clampPct(fh.percent)
      : (fh && typeof fh.used === 'number' && typeof fh.total === 'number' && fh.total > 0)
        ? this.clampPct((fh.used / fh.total) * 100)
        : 0;

    const weeklyPct = sd?.percent != null
      ? this.clampPct(sd.percent)
      : (sd && typeof sd.used === 'number' && typeof sd.total === 'number' && sd.total > 0)
        ? this.clampPct((sd.used / sd.total) * 100)
        : 0;

    const sessionReset = this.formatReset(fh?.reset_at, fh?.reset_after_seconds);
    const weeklyReset = this.formatReset(sd?.reset_at, sd?.reset_after_seconds);

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
      error: parseFailed ? 'Could not parse Z.AI usage data' : undefined,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseDomUsage(page: any): Promise<ProviderUsageData> {
    try {
      await page.waitForSelector('body', { timeout: 4_000 });
      await new Promise(r => setTimeout(r, 1_200));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const extracted = await page.evaluate(() => {
        const txt = (document.body?.innerText ?? '') || '';

        const pctPattern = /(\d+(?:\.\d+)?)\s*%/g;
        const pcts: number[] = [];
        let m: RegExpExecArray | null;
        while ((m = pctPattern.exec(txt)) !== null) {
          pcts.push(parseFloat(m[1]));
        }

        const ratioPattern = /(\d+)\s*\/\s*(\d+)/g;
        const ratios: Array<{ used: number; total: number }> = [];
        while ((m = ratioPattern.exec(txt)) !== null) {
          const used = parseInt(m[1], 10);
          const total = parseInt(m[2], 10);
          if (total > 0 && used <= total * 2) {
            ratios.push({ used, total });
          }
        }

        const timePattern = /(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:AM|PM)?/gi;
        const times: string[] = [];
        while ((m = timePattern.exec(txt)) !== null) {
          times.push(m[0]);
        }

        const datePatterns = [
          /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g,
          /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/g,
          /\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}/g,
        ];
        const dates: string[] = [];
        for (const p of datePatterns) {
          while ((m = p.exec(txt)) !== null) {
            dates.push(m[0]);
          }
        }

        return {
          hasUsageContent: txt.includes('用量') || txt.includes('额度') || txt.includes('5小时') || txt.includes('每周') || txt.includes('5h') || txt.includes('weekly') || txt.includes('usage'),
          pcts,
          ratios,
          times,
          dates,
          textLen: txt.length,
        };
      });

      if (!extracted.hasUsageContent) {
        return this.errorResult(new ProviderScrapeError('unauthorized', 'Usage page content not found — may need re-authentication', false), 'browser-fallback');
      }

      let sessionPct = 0;
      let weeklyPct = 0;

      if (extracted.ratios.length >= 2) {
        sessionPct = this.clampPct((extracted.ratios[0].used / extracted.ratios[0].total) * 100);
        weeklyPct = this.clampPct((extracted.ratios[1].used / extracted.ratios[1].total) * 100);
      } else if (extracted.ratios.length === 1) {
        sessionPct = this.clampPct((extracted.ratios[0].used / extracted.ratios[0].total) * 100);
      }

      if (sessionPct === 0 && weeklyPct === 0 && extracted.pcts.length >= 2) {
        sessionPct = this.clampPct(extracted.pcts[0]);
        weeklyPct = this.clampPct(extracted.pcts[1]);
      } else if (sessionPct === 0 && extracted.pcts.length >= 1) {
        sessionPct = this.clampPct(extracted.pcts[0]);
      }

      let sessionReset = '--';
      let weeklyReset = '--';
      if (extracted.dates.length >= 2) {
        sessionReset = this.formatDateStr(extracted.dates[0]);
        weeklyReset = this.formatDateStr(extracted.dates[1]);
      } else if (extracted.dates.length === 1) {
        sessionReset = this.formatDateStr(extracted.dates[0]);
      } else if (extracted.times.length >= 2) {
        sessionReset = extracted.times[0];
        weeklyReset = extracted.times[1];
      } else if (extracted.times.length === 1) {
        sessionReset = extracted.times[0];
      }

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
        error: parseFailed ? 'Could not extract usage from page DOM' : undefined,
      };
    } catch (err) {
      return this.errorResult(toProviderScrapeError(err), 'browser-fallback');
    }
  }

  private clampPct(value: number): number {
    return clampPct(value);
  }

  private formatReset(resetAt?: string | number | null, resetAfterSec?: number | null): string {
    if (resetAt != null) {
      const d = typeof resetAt === 'number'
        ? new Date(resetAt > 1e12 ? resetAt : resetAt * 1000)
        : new Date(resetAt);
      if (!Number.isNaN(d.getTime())) return formatDateShort(d);
    }
    if (typeof resetAfterSec === 'number' && Number.isFinite(resetAfterSec) && resetAfterSec > 0) {
      return formatDateShort(new Date(Date.now() + resetAfterSec * 1000));
    }
    return '--';
  }

  private formatDateStr(raw: string): string {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return formatDateShort(d);
    return raw;
  }

  private formatDate(d: Date): string {
    return formatDateShort(d);
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
      scrapedAt: Date.now(),
      error: mapped.message,
      errorCode: mapped.code,
      source,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    };
  }
}

import type { ProviderConnector, ProviderUsageData } from './types.js';
import { getSupportedProvider } from '../config/providers.js';
import { hasCookies, deleteCookies, authenticate, createScrapePageForProvider } from './browser.js';
import { loadProviderSession } from './session.js';
import { fetchOpenCodeGoUsageApi } from './opencodego-api.js';
import { getFallbackMode, shouldFallbackToBrowser } from './fallback-policy.js';
import { ProviderScrapeError, toProviderScrapeError } from './errors.js';
import { recordScrapeMetric } from './metrics.js';
import { clampPct, formatDateShort } from './format-utils.js';

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
      const result = this.errorRow(new ProviderScrapeError('not_configured', 'Not configured', false), 'api', startedAt);
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: result.durationMs ?? 0, success: false, errorCode: result.errorCode, at: Date.now() });
      return result;
    }

    try {
      const data = await fetchOpenCodeGoUsageApi(session, apiTimeout);
      data.source = 'api';
      data.durationMs = Date.now() - startedAt;
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: data.durationMs, success: true, at: Date.now() });
      return data;
    } catch (err) {
      const mapped = toProviderScrapeError(err);
      recordScrapeMetric({ providerId: this.id, mode, source: 'api', durationMs: Date.now() - startedAt, success: false, errorCode: mapped.code, at: Date.now() });

      if (shouldFallbackToBrowser(mapped.code, getFallbackMode())) {
        const fbStart = Date.now();
        const fb = await this.scrapeUsageBrowserFallback();
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

      return this.errorRow(mapped, 'api', startedAt);
    }
  }

  removeConfig(): void {
    deleteCookies(this.id);
  }

  private async scrapeUsageBrowserFallback(): Promise<ProviderUsageData> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any | null = null;
    try {
      page = await createScrapePageForProvider(this.id);

      await page.goto('https://opencode.ai/auth', { waitUntil: 'networkidle2', timeout: 15000 });
      const authRedirectUrl = page.url();
      const wsMatch = authRedirectUrl.match(/\/workspace\/([^/?#]+)/);
      if (!wsMatch?.[1]) {
        throw new ProviderScrapeError('unauthorized', 'Could not discover workspace ID from auth redirect', false);
      }
      const workspaceId = wsMatch[1];

      await page.goto(`https://opencode.ai/workspace/${workspaceId}/go`, { waitUntil: 'networkidle2', timeout: 15000 });

      return await this.parseDomUsage(page);
    } catch (err) {
      return this.errorRow(toProviderScrapeError(err), 'browser-fallback');
    } finally {
      if (page) { try { await page.close(); } catch { /* ignore */ } }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseDomUsage(page: any): Promise<ProviderUsageData> {
    try {
      const extracted = await page.evaluate(() => {
        const txt = (document.body?.innerText ?? '') || '';

        const rollingMatch = txt.match(/Rolling Usage\s*([\d.]+)\s*%/i);
        const weeklyMatch = txt.match(/Weekly Usage\s*([\d.]+)\s*%/i);
        const monthlyMatch = txt.match(/Monthly Usage\s*([\d.]+)\s*%/i);

        const rollingResetMatch = txt.match(/Rolling Usage[\s\S]*?Resets in\s*([\d]+\s*(?:hours?|minutes?|days?)(?:\s*[\d]+\s*(?:hours?|minutes?|days?))*)/i);
        const weeklyResetMatch = txt.match(/Weekly Usage[\s\S]*?Resets in\s*([\d]+\s*(?:hours?|minutes?|days?)(?:\s*[\d]+\s*(?:hours?|minutes?|days?))*)/i);
        const monthlyResetMatch = txt.match(/Monthly Usage[\s\S]*?Resets in\s*([\d]+\s*(?:hours?|minutes?|days?)(?:\s*[\d]+\s*(?:hours?|minutes?|days?))*)/i);

        const hasGoContent =
          txt.includes('Rolling Usage') ||
          txt.includes('Weekly Usage') ||
          txt.includes('Monthly Usage') ||
          txt.includes('OpenCode Go');

        return {
          hasGoContent,
          sessionPct: rollingMatch ? parseFloat(rollingMatch[1]) : 0,
          weeklyPct: weeklyMatch ? parseFloat(weeklyMatch[1]) : 0,
          monthlyPct: monthlyMatch ? parseFloat(monthlyMatch[1]) : 0,
          sessionReset: rollingResetMatch ? rollingResetMatch[1].trim() : '',
          weeklyReset: weeklyResetMatch ? weeklyResetMatch[1].trim() : '',
          monthlyReset: monthlyResetMatch ? monthlyResetMatch[1].trim() : '',
        };
      });

      if (!extracted.hasGoContent) {
        return this.errorRow(
          new ProviderScrapeError('unauthorized', 'Go usage page content not found — may need re-authentication', false),
          'browser-fallback',
        );
      }

      const sessionPct = clampPct(extracted.sessionPct);
      const weeklyPct = clampPct(extracted.weeklyPct);
      const monthlyPct = clampPct(extracted.monthlyPct);
      const sessionReset = extracted.sessionReset || '--';
      const weeklyReset = extracted.weeklyReset || '--';
      const monthlyReset = extracted.monthlyReset || '--';

      const parseFailed = sessionPct === 0 && weeklyPct === 0 && monthlyPct === 0 &&
        sessionReset === '--' && weeklyReset === '--' && monthlyReset === '--';

      return {
        providerId: this.id,
        providerLabel: this.label,
        color: this.color,
        sessionUsedPct: sessionPct,
        weeklyUsedPct: weeklyPct,
        sessionResetDate: sessionReset,
        weeklyResetDate: weeklyReset,
        monthlyUsedPct: monthlyPct,
        monthlyResetDate: monthlyReset,
        scrapedAt: Date.now(),
        error: parseFailed ? 'Could not extract usage from page DOM' : undefined,
      };
    } catch (err) {
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
      scrapedAt: Date.now(),
      error: mapped.message,
      errorCode: mapped.code,
      source,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    };
  }
}

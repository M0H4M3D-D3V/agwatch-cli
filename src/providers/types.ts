export type ProviderUsageData = {
  providerId: string;
  providerLabel: string;
  color: string;
  sessionUsedPct: number;
  weeklyUsedPct: number;
  sessionResetDate: string;
  weeklyResetDate: string;
  monthlyUsedPct?: number;
  monthlyResetDate?: string;
  designWeeklyUsedPct?: number;
  designWeeklyResetDate?: string;
  scrapedAt: number;
  error?: string;
  errorCode?:
    | 'unauthorized'
    | 'timeout'
    | 'network_error'
    | 'endpoint_not_found'
    | 'payload_invalid'
    | 'anti_bot_block'
    | 'not_configured'
    | 'unknown';
  source?: 'api' | 'browser-fallback';
  durationMs?: number;
};

export interface ProviderConnector {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  isConfigured(): boolean;
  authenticate(onStatus?: (msg: string) => void): Promise<void>;
  scrapeUsage(options?: { allowVisibleFallback?: boolean }): Promise<ProviderUsageData>;
  removeConfig(): void;
}

export type ScrapeMetric = {
  providerId: string;
  mode: 'startup' | 'manual';
  source: 'api' | 'browser-fallback';
  durationMs: number;
  success: boolean;
  errorCode?: string;
  at: number;
};

const MAX_METRICS = 300;
const metrics: ScrapeMetric[] = [];

export function recordScrapeMetric(metric: ScrapeMetric): void {
  metrics.push(metric);
  if (metrics.length > MAX_METRICS) {
    metrics.splice(0, metrics.length - MAX_METRICS);
  }
}

export function getRecentScrapeMetrics(limit: number = 50): ScrapeMetric[] {
  if (limit <= 0) return [];
  return metrics.slice(-limit);
}

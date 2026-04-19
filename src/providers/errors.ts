export type ProviderScrapeErrorCode =
  | 'unauthorized'
  | 'timeout'
  | 'network_error'
  | 'endpoint_not_found'
  | 'payload_invalid'
  | 'anti_bot_block'
  | 'not_configured'
  | 'unknown';

export class ProviderScrapeError extends Error {
  code: ProviderScrapeErrorCode;
  retryable: boolean;

  constructor(code: ProviderScrapeErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderScrapeError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isProviderScrapeError(err: unknown): err is ProviderScrapeError {
  return err instanceof ProviderScrapeError;
}

export function toProviderScrapeError(err: unknown): ProviderScrapeError {
  if (isProviderScrapeError(err)) return err;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timed out') || msg.includes('timeout')) {
      return new ProviderScrapeError('timeout', err.message, true);
    }
    if (msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('401') || msg.includes('403')) {
      return new ProviderScrapeError('unauthorized', err.message, false);
    }
    if (msg.includes('cloudflare') || msg.includes('captcha') || msg.includes('blocked')) {
      return new ProviderScrapeError('anti_bot_block', err.message, true);
    }
    if (msg.includes('network') || msg.includes('fetch failed') || msg.includes('econn') || msg.includes('enotfound')) {
      return new ProviderScrapeError('network_error', err.message, true);
    }
    return new ProviderScrapeError('unknown', err.message, true);
  }

  return new ProviderScrapeError('unknown', 'Unknown scrape error', true);
}

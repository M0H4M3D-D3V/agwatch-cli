import type { ProviderScrapeErrorCode } from './errors.js';
import { getProviderRuntimeOptions } from './runtime-options.js';
import type { FallbackMode } from './runtime-options.js';

export function getFallbackMode(): FallbackMode {
  return getProviderRuntimeOptions().fallbackMode;
}

export function shouldFallbackToBrowser(errorCode: ProviderScrapeErrorCode, mode: FallbackMode): boolean {
  if (mode === 'never') return false;
  if (mode === 'on_any_error') return true;
  return errorCode === 'unauthorized' || errorCode === 'anti_bot_block';
}

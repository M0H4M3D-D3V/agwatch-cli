import os from 'node:os';
import path from 'node:path';

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'agwatch');
  return path.join(os.homedir(), '.config', 'agwatch');
}

export function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function getProviderCookiesDir(): string {
  return path.join(getConfigDir(), 'provider-cookies');
}

export function getProviderCookiesPath(providerId: string): string {
  return path.join(getProviderCookiesDir(), `${providerId}.json`);
}

export function getPricingCacheFile(): string {
  return path.join(getConfigDir(), 'pricing-cache.json');
}

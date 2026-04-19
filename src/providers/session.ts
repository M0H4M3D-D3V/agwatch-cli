import fs from 'node:fs';
import { getProviderCookiesPath } from '../utils/paths.js';

type CookieRow = {
  name?: string;
  value?: string;
};

export type ProviderSession = {
  providerId: string;
  cookieHeader: string;
  cookiesByName: Record<string, string>;
  bearerToken?: string;
};

function cookiesPath(providerId: string): string {
  return getProviderCookiesPath(providerId);
}

export function loadProviderSession(providerId: string): ProviderSession | null {
  const p = cookiesPath(providerId);
  if (!fs.existsSync(p)) return null;

  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const arr = JSON.parse(raw) as CookieRow[];
    if (!Array.isArray(arr) || arr.length === 0) return null;

    const cookiesByName: Record<string, string> = {};
    for (const row of arr) {
      if (!row || typeof row.name !== 'string' || typeof row.value !== 'string') continue;
      cookiesByName[row.name] = row.value;
    }

    const cookiePairs = Object.entries(cookiesByName).map(([k, v]) => `${k}=${v}`);
    if (cookiePairs.length === 0) return null;

    const bearerToken =
      cookiesByName['token'] ||
      cookiesByName['__Secure-next-auth.session-token'] ||
      cookiesByName['next-auth.session-token'];

    return {
      providerId,
      cookieHeader: cookiePairs.join('; '),
      cookiesByName,
      bearerToken: bearerToken && bearerToken.length > 0 ? bearerToken : undefined,
    };
  } catch {
    return null;
  }
}

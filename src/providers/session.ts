import fs from 'node:fs';
import { getProviderCookiesPath } from '../utils/paths.js';
import { decryptCookies } from './secret-store.js';

type CookieRow = {
  name?: string;
  value?: string;
  expires?: number;
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
    const all = decryptCookies(raw, providerId) as CookieRow[];
    if (!Array.isArray(all) || all.length === 0) return null;

    // Discard cookies that have a past expiry timestamp.
    const nowSec = Date.now() / 1000;
    const arr = all.filter((row) => {
      if (typeof row.expires !== 'number') return true; // session cookie, no expiry field
      if (Number.isNaN(row.expires)) return true;       // guard: NaN treated as session cookie
      if (row.expires <= 0) return true;                // session cookie encoded as -1 or 0
      return row.expires > nowSec;
    });

    // All stored cookies are expired — clear the file so next call triggers re-auth.
    if (arr.length === 0) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
      return null;
    }

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

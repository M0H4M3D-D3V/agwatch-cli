import path from 'node:path';
import fs from 'node:fs';
import { getProviderCookiesDir, getProviderCookiesPath } from '../utils/paths.js';

const COOKIES_DIR = getProviderCookiesDir();

function cookiesPath(providerId: string): string {
  return getProviderCookiesPath(providerId);
}

export function hasCookies(providerId: string): boolean {
  return fs.existsSync(cookiesPath(providerId));
}

export function deleteCookies(providerId: string): void {
  const p = cookiesPath(providerId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  _cookiesCache.delete(providerId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _scrapeBrowser: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _authBrowser: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _scrapeBrowserLaunchPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _authBrowserLaunchPromise: Promise<any> | null = null;
let _closingPromise: Promise<void> | null = null;
let _stealthPluginRegistered = false;

// In-memory cookie cache — avoids disk reads on every scrape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _cookiesCache = new Map<string, any[]>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCachedCookies(providerId: string): any[] {
  if (_cookiesCache.has(providerId)) return _cookiesCache.get(providerId)!;
  const cookiesFile = cookiesPath(providerId);
  if (!fs.existsSync(cookiesFile)) return [];
  try {
    const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf-8'));
    const arr = Array.isArray(cookies) ? cookies : [];
    if (arr.length > 0) _cookiesCache.set(providerId, arr);
    return arr;
  } catch {
    return [];
  }
}

/**
 * Creates a fresh scrape page for the given provider using the persistent browser
 * singleton and in-memory cookie cache. Always returns a new page with no navigation
 * history — caller MUST close it in a finally block after use.
 *
 * We intentionally do NOT pool pages across scrapes: reusing a page that has already
 * visited usageUrl and then navigating to about:blank between scrapes puts usageUrl
 * into Chrome's back-forward cache (bfcache). When goto(usageUrl) is called again,
 * Chrome restores from bfcache without re-executing JavaScript, so the usage XHR
 * never fires and waitForResponse times out. Fresh pages have no navigation history,
 * so bfcache never applies.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createScrapePageForProvider(providerId: string): Promise<any> {
  const browser = await getScrapeBrowser();
  const page = await browser.newPage();
  await page.setCacheEnabled(false);

  const cookies = getCachedCookies(providerId);
  if (cookies.length > 0) await page.setCookie(...cookies);

  return page;
}

/** Kick off browser launch in the background so it's ready when scraping starts. */
export function prewarmScrapeBrowser(): void {
  getScrapeBrowser().catch(() => {});
}

function canOpenVisibleBrowser(): boolean {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function getChromiumExecutablePath(): Promise<string | undefined> {
  // On Windows, puppeteer-extra can auto-detect Chrome; skip explicit path.
  if (process.platform === 'win32') return undefined;

  // Try to get the bundled Chromium path from the installed full `puppeteer` package.
  try {
    const puppeteer = (await import('puppeteer')) as any;
    const execPath =
      typeof puppeteer?.default?.executablePath === 'function'
        ? puppeteer.default.executablePath()
        : typeof puppeteer?.executablePath === 'function'
        ? puppeteer.executablePath()
        : undefined;
    if (execPath && fs.existsSync(execPath)) return execPath;
  } catch {
    // puppeteer not installed or no bundled browser — fall through to system Chrome
  }

  // Fall back to system-installed Chrome/Chromium.
  const systemPaths: string[] =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/snap/bin/chromium',
          '/usr/bin/brave-browser',
        ];

  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }

  return undefined;
}

async function launchBrowser(headless: boolean): Promise<any> {
  const puppeteerExtra = (await import('puppeteer-extra')).default as any;
  if (!_stealthPluginRegistered) {
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default as any;
    puppeteerExtra.use(StealthPlugin());
    _stealthPluginRegistered = true;
  }

  const args: string[] = [];
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }

  const executablePath = await getChromiumExecutablePath();

  if (!executablePath && process.platform !== 'win32') {
    throw new Error(
      'Chrome or Chromium not found. Install Google Chrome, or run `agwatch providers install` to download a bundled browser.',
    );
  }

  return puppeteerExtra.launch({
    headless,
    args,
    defaultViewport: null,
    ...(executablePath ? { executablePath } : {}),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function configureVisiblePage(_page: any): Promise<void> {
  // No-op: auth browser opens at the OS default size with no zoom overrides.
}

async function getScrapeBrowser(): Promise<any> {
  if (_scrapeBrowser && _scrapeBrowser.connected) return _scrapeBrowser;

  if (_scrapeBrowserLaunchPromise) {
    _scrapeBrowser = await _scrapeBrowserLaunchPromise;
    return _scrapeBrowser;
  }

  _scrapeBrowserLaunchPromise = launchBrowser(true);
  try {
    _scrapeBrowser = await _scrapeBrowserLaunchPromise;
  } finally {
    _scrapeBrowserLaunchPromise = null;
  }
  return _scrapeBrowser;
}

async function getAuthBrowser(): Promise<any> {
  if (_authBrowser && _authBrowser.connected) return _authBrowser;

  if (_authBrowserLaunchPromise) {
    _authBrowser = await _authBrowserLaunchPromise;
    return _authBrowser;
  }

  _authBrowserLaunchPromise = launchBrowser(false);
  try {
    _authBrowser = await _authBrowserLaunchPromise;
    const pages = await _authBrowser.pages();
    await Promise.all(pages.map((page: any) => configureVisiblePage(page)));
  } finally {
    _authBrowserLaunchPromise = null;
  }
  return _authBrowser;
}

async function closeAuthBrowser(): Promise<void> {
  if (_authBrowser) {
    await safeClose(_authBrowser);
    _authBrowser = null;
  }
}

async function safeClose(browser: any): Promise<void> {
  try {
    const proc = typeof browser?.process === 'function' ? browser.process() : null;
    const alreadyDead = !!proc && (proc.killed || proc.exitCode !== null);
    if (alreadyDead) return;
    await browser.close();
  } catch {
    // ignore noisy shutdown races on fast exit
  }
}

export async function closeBrowser(): Promise<void> {
  if (_closingPromise) {
    await _closingPromise;
    return;
  }

  _closingPromise = (async () => {
    _cookiesCache.clear();

    if (_authBrowser) {
      await safeClose(_authBrowser);
      _authBrowser = null;
    }
    _authBrowserLaunchPromise = null;

    if (_scrapeBrowser) {
      await safeClose(_scrapeBrowser);
      _scrapeBrowser = null;
    }
    _scrapeBrowserLaunchPromise = null;
  })();

  try {
    await _closingPromise;
  } finally {
    _closingPromise = null;
  }
}

export function releaseBrowserHandles(): void {
  try {
    _cookiesCache.clear();

    if (_authBrowser) {
      try {
        _authBrowser.disconnect();
      } catch {
        // ignore
      }
      _authBrowser = null;
    }
    _authBrowserLaunchPromise = null;

    if (_scrapeBrowser) {
      try {
        _scrapeBrowser.disconnect();
      } catch {
        // ignore
      }
      _scrapeBrowser = null;
    }
    _scrapeBrowserLaunchPromise = null;
  } catch {
    // ignore
  }
}

export async function authenticate(
  providerId: string,
  authUrl: string,
  successPattern: string,
  verifyUrl: string | undefined,
  onStatus?: (msg: string) => void,
): Promise<boolean> {
  if (!canOpenVisibleBrowser()) {
    onStatus?.('Cannot open auth browser: no display server detected. Set DISPLAY or WAYLAND_DISPLAY.');
    return false;
  }

  const browser = await getAuthBrowser();
  onStatus?.('Browser opened. Please log in...');

  const page = (await browser.pages())[0] || await browser.newPage();
  await configureVisiblePage(page);

  try {
    const cookiesFile = cookiesPath(providerId);

    // Bug 3 fix: wrap cookie load so a malformed file returns false instead of throwing.
    if (fs.existsSync(cookiesFile)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf-8'));
        if (Array.isArray(cookies) && cookies.length > 0) await page.setCookie(...cookies);
      } catch {
        // Ignore corrupt cookies — user will log in fresh.
      }
    }

    await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 120_000 });

    onStatus?.('Waiting for successful login...');
    const timeoutMs = 600_000;
    const pollMs = 1500;
    const start = Date.now();
    let success = false;

    while (Date.now() - start < timeoutMs) {
      // Bug 4 fix: if the user closes the browser window, page.url() throws — treat as still waiting.
      let href = '';
      try {
        href = page.url().toLowerCase();
      } catch {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }

      const hasPattern = href.includes(successPattern.toLowerCase());
      const stillInAuthFlow =
        href.includes('/auth') ||
        href.includes('/login') ||
        href.includes('/signin') ||
        href.includes('/sign-in');

      const cookies = await page.cookies();
      const hasSessionCookie = cookies.some((c: { name: string }) =>
        /session|token|auth|next-auth/i.test(c.name),
      );
      const hasSolidSessionCookie = cookies.some((c: { name: string }) =>
        /__secure-next-auth\.session-token|next-auth\.session-token|session-token/i.test(c.name),
      );

      const markers = await page.evaluate(() => {
        const txt = (document.body?.innerText ?? '').toLowerCase();
        const hasLoginMarkers =
          txt.includes('continue with google') ||
          txt.includes('continue with microsoft') ||
          txt.includes('continue with apple') ||
          txt.includes('log in') ||
          txt.includes('sign in') ||
          txt.includes('enter your email') ||
          txt.includes('登录') ||
          txt.includes('注册') ||
          txt.includes('手机号') ||
          txt.includes('验证码') ||
          txt.includes('扫码登录') ||
          txt.includes('微信扫码');
        const hasAppMarkers =
          txt.includes('new chat') ||
          txt.includes('settings') ||
          txt.includes('projects') ||
          txt.includes('codex') ||
          txt.includes('workspace') ||
          txt.includes('套餐') ||
          txt.includes('用量') ||
          txt.includes('控制台') ||
          txt.includes('模型');
        return { hasLoginMarkers, hasAppMarkers };
      });

      // Candidate success: auth page left + session-like cookies.
      const candidate = (hasPattern && !stillInAuthFlow && hasSessionCookie) || (hasSolidSessionCookie && !markers.hasLoginMarkers);

      if (candidate) {
        let verified = true;

        // Strong verification: check protected usage page in a background tab.
        if (verifyUrl) {
          verified = false;
          // Bug 2 fix: always close verifyPage in a finally block.
          let verifyPage: any = null;
          try {
            verifyPage = await browser.newPage();
            await configureVisiblePage(verifyPage);
            await verifyPage.setCookie(...cookies);
            await verifyPage.goto(verifyUrl, { waitUntil: 'networkidle2', timeout: 60_000 });

            const verifyHref = verifyPage.url().toLowerCase();
            const redirectedToAuth =
              verifyHref.includes('/auth') ||
              verifyHref.includes('/login') ||
              verifyHref.includes('/signin') ||
              verifyHref.includes('/sign-in');

            const verifyMarkers = await verifyPage.evaluate(() => {
              const txt = (document.body?.innerText ?? '').toLowerCase();
              const hasLoginMarkers =
                txt.includes('continue with google') ||
                txt.includes('continue with microsoft') ||
                txt.includes('continue with apple') ||
                txt.includes('log in') ||
                txt.includes('sign in') ||
                txt.includes('enter your email') ||
                txt.includes('one-time password') ||
                txt.includes('otp') ||
                txt.includes('登录') ||
                txt.includes('注册') ||
                txt.includes('手机号') ||
                txt.includes('验证码') ||
                txt.includes('扫码登录') ||
                txt.includes('微信扫码');
              const hasUsageMarkers =
                txt.includes('usage') ||
                txt.includes('rate limit') ||
                txt.includes('weekly') ||
                txt.includes('5h') ||
                txt.includes('codex') ||
                txt.includes('用量') ||
                txt.includes('额度') ||
                txt.includes('套餐') ||
                txt.includes('5小时') ||
                txt.includes('每周');
              return { hasLoginMarkers, hasUsageMarkers };
            });

            verified = !redirectedToAuth && !verifyMarkers.hasLoginMarkers && verifyMarkers.hasUsageMarkers;
          } catch {
            verified = false;
          } finally {
            if (verifyPage) { try { await verifyPage.close(); } catch { /* ignore */ } }
          }
        }

        if (verified) {
          success = true;
          break;
        }
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    if (!success) {
      onStatus?.('Auth timed out.');
      return false;
    }

    const cookiesFile2 = cookiesPath(providerId);
    const finalCookies = await page.cookies();
    if (!fs.existsSync(COOKIES_DIR)) {
      fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(cookiesFile2, JSON.stringify(finalCookies, null, 2), { encoding: 'utf-8', mode: 0o600 });

    // Clear cookie cache so next scrape loads the fresh cookies from disk.
    _cookiesCache.delete(providerId);

    onStatus?.('Auth successful. Saving session...');
    return true;
  } finally {
    await closeAuthBrowser();
  }
}

export async function scrapePageHtml(
  providerId: string,
  url: string,
): Promise<string> {
  const browser = await getScrapeBrowser();
  // Use a fresh page to avoid bfcache returning stale content (same reason as createScrapePageForProvider).
  const page = await browser.newPage();
  await page.setCacheEnabled(false);

  try {
    const cookiesFile = cookiesPath(providerId);
    if (fs.existsSync(cookiesFile)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf-8'));
        if (Array.isArray(cookies) && cookies.length > 0) await page.setCookie(...cookies);
      } catch { /* ignore malformed cookies */ }
    }

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise(r => setTimeout(r, 2000));

    return await page.content();
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getScrapedPage(providerId: string, url: string, headless: boolean = true): Promise<any> {
  const browser = headless ? await getScrapeBrowser() : await getAuthBrowser();
  const page = await browser.newPage();
  if (headless) await page.setCacheEnabled(false);
  if (!headless) await configureVisiblePage(page);

  const cookiesFile = cookiesPath(providerId);
  if (fs.existsSync(cookiesFile)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf-8'));
      if (Array.isArray(cookies) && cookies.length > 0) await page.setCookie(...cookies);
    } catch { /* ignore malformed cookies */ }
  }

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 2000));

  return page;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getPreparedPage(providerId: string, headless: boolean = true): Promise<any> {
  const browser = headless ? await getScrapeBrowser() : await getAuthBrowser();
  const page = await browser.newPage();
  if (headless) await page.setCacheEnabled(false);
  if (!headless) await configureVisiblePage(page);

  const cookiesFile = cookiesPath(providerId);
  if (fs.existsSync(cookiesFile)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf-8'));
      if (Array.isArray(cookies) && cookies.length > 0) await page.setCookie(...cookies);
    } catch { /* ignore malformed cookies */ }
  }

  return page;
}

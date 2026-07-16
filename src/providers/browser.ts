import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { getProviderCookiesDir, getProviderCookiesPath } from '../utils/paths.js';
import { encryptCookies, decryptCookies, isAuthCookie, setRestrictiveFilePerms } from './secret-store.js';
import {
  getPuppeteerBrowserPath,
  installPuppeteer,
  isPuppeteerUsable,
  loadPuppeteerModules,
  terminateProcessTree,
} from './deps.js';

const COOKIES_DIR = getProviderCookiesDir();

function cookiesPath(providerId: string): string {
  return getProviderCookiesPath(providerId);
}

export function hasCookies(providerId: string): boolean {
  return getCachedCookies(providerId).some((cookie) =>
    /session|token|auth|sid|next-auth/i.test(String(cookie?.name ?? '')),
  );
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
type ScrapeBrowserLaunch = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  promise: Promise<any>;
  controller: AbortController;
  waiters: Set<symbol>;
};
let _scrapeBrowserLaunch: ScrapeBrowserLaunch | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _authBrowserLaunchPromise: Promise<any> | null = null;
let _authBrowserLaunchController: AbortController | null = null;
let _closingPromise: Promise<void> | null = null;
let _stealthPluginRegistered = false;

// In-memory cookie cache — avoids disk reads on every scrape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _cookiesCache = new Map<string, any[]>();

function filterValidCookies(cookies: any[]): any[] {
  const nowSeconds = Date.now() / 1000;
  return cookies.filter((cookie) => {
    if (!cookie || typeof cookie !== 'object') return false;
    const expires = (cookie as { expires?: unknown }).expires;
    return typeof expires !== 'number' || expires <= 0 || expires > nowSeconds;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCachedCookies(providerId: string): any[] {
  const cookiesFile = cookiesPath(providerId);
  if (_cookiesCache.has(providerId)) {
    const valid = filterValidCookies(_cookiesCache.get(providerId)!);
    if (valid.length > 0) {
      _cookiesCache.set(providerId, valid);
      return valid;
    }
    _cookiesCache.delete(providerId);
    if (fs.existsSync(cookiesFile)) fs.unlinkSync(cookiesFile);
    return [];
  }
  if (!fs.existsSync(cookiesFile)) return [];
  try {
    const raw = fs.readFileSync(cookiesFile, 'utf-8');
    const arr = decryptCookies(raw, providerId);
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const valid = filterValidCookies(arr);
    if (valid.length === 0) {
      fs.unlinkSync(cookiesFile);
      _cookiesCache.delete(providerId);
      return [];
    }
    _cookiesCache.set(providerId, valid);
    return valid;
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
export async function createScrapePageForProvider(providerId: string, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  const browser = await getScrapeBrowser(signal);
  signal?.throwIfAborted();
  let page: any | null = null;

  try {
    page = await browser.newPage();
    signal?.throwIfAborted();

    const onAbort = () => { void page?.close().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    page.once('close', () => signal?.removeEventListener('abort', onAbort));

    await page.setCacheEnabled(false);
    const cookies = getCachedCookies(providerId);
    if (cookies.length > 0) await page.setCookie(...cookies);
    signal?.throwIfAborted();
    return page;
  } catch (err) {
    if (page) { try { await page.close(); } catch { /* ignore */ } }
    throw err;
  }
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
  // Respect an explicit override from the environment.
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // Try bundled Chromium from the installed full `puppeteer` package.
  try {
    const execPath = await getPuppeteerBrowserPath();
    if (execPath) return execPath;
  } catch {
    // puppeteer not installed or browser not yet downloaded
  }

  // Known system Chrome/Chromium paths.
  const home = os.homedir();
  const systemPaths: string[] = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Chromium', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          // System-wide installs (most common)
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          // Per-user installs (drag-and-drop to ~/Applications)
          `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
          `${home}/Applications/Chromium.app/Contents/MacOS/Chromium`,
          `${home}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
          // Homebrew (Apple Silicon)
          '/opt/homebrew/bin/chromium',
          '/opt/homebrew/bin/google-chrome',
          // Homebrew (Intel)
          '/usr/local/bin/chromium',
          '/usr/local/bin/google-chrome',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/snap/bin/chromium',
          '/usr/bin/brave-browser',
          '/usr/bin/microsoft-edge',
        ];

  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }

  return findChromiumInCache();
}

// Recursively search a directory for a Chrome/Chromium executable.
// Used as a fallback when puppeteer.executablePath() returns a path that doesn't exist
// (e.g. puppeteer installed but its Chrome download silently failed).
function searchForExecutable(dir: string, names: Set<string>, maxDepth: number): string | undefined {
  if (maxDepth <= 0 || !fs.existsSync(dir)) return undefined;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (names.has(entry)) {
        try {
          const stat = fs.statSync(full);
          if (!stat.isDirectory()) {
            fs.accessSync(full, fs.constants.X_OK);
            return full;
          }
        } catch { /* not executable */ }
      }
      try {
        if (fs.statSync(full).isDirectory()) {
          const found = searchForExecutable(full, names, maxDepth - 1);
          if (found) return found;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return undefined;
}

function findChromiumInCache(): string | undefined {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
  const names = new Set(
    process.platform === 'win32'
      ? ['chrome.exe', 'chromium.exe']
      : process.platform === 'darwin'
      ? ['Google Chrome for Testing', 'Google Chrome', 'Chromium', 'chromium', 'chrome']
      : ['chrome', 'chromium', 'google-chrome', 'google-chrome-stable'],
  );
  return searchForExecutable(cacheDir, names, 10);
}

async function launchBrowser(headless: boolean, onStatus?: (msg: string) => void, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  if (!(await isPuppeteerUsable())) {
    throw new Error(
      'Puppeteer not installed — browser fallback requires it. ' +
      'Press p → select a provider to install Puppeteer and authenticate.',
    );
  }

  const { puppeteerExtra, StealthPlugin } = await loadPuppeteerModules();
  signal?.throwIfAborted();
  if (!_stealthPluginRegistered) {
    puppeteerExtra.use(StealthPlugin());
    _stealthPluginRegistered = true;
  }
  const launch = async (options: Record<string, unknown>): Promise<any> => {
    signal?.throwIfAborted();
    // puppeteer-extra deep-merges options, which corrupts AbortSignal into a plain object.
    const browser = await puppeteerExtra.launch(options);
    if (signal?.aborted) {
      await safeClose(browser);
      signal.throwIfAborted();
    }
    return browser;
  };

  const args: string[] = [];
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }

  let executablePath = await getChromiumExecutablePath();
  signal?.throwIfAborted();

  if (executablePath) {
    return launch({ headless, args, defaultViewport: null, executablePath });
  }

  // Try puppeteer-extra's built-in detection (works on Windows when Chrome is in Program Files,
  // and may work on macOS/Linux too). On failure, fall through to auto-download.
  if (process.platform === 'win32') {
    try {
      return await launch({ headless, args, defaultViewport: null });
    } catch { signal?.throwIfAborted(); }
  }

  // macOS / Linux: try channel-based detection first (instant if Chrome is installed).
  const channels = ['chrome', 'chromium', 'chrome-canary'] as const;
  for (const channel of channels) {
    try {
      return await launch({ headless, args, defaultViewport: null, channel });
    } catch {
      signal?.throwIfAborted();
      // try next channel
    }
  }

  // Still nothing: repair only the missing runtime component.
  onStatus?.('No browser found. Downloading Chromium (one-time, may take a minute)...');
  try {
    await installPuppeteer(onStatus, signal);
  } catch { signal?.throwIfAborted(); }

  // After the install attempt, try every detection path including the cache search.
  executablePath = await getChromiumExecutablePath();
  signal?.throwIfAborted();

  if (executablePath) {
    onStatus?.('Browser ready.');
    return launch({ headless, args, defaultViewport: null, executablePath });
  }

  // Last resort: channel detection again (in case the install added Chrome to a known location).
  for (const channel of channels) {
    try {
      return await launch({ headless, args, defaultViewport: null, channel });
    } catch { signal?.throwIfAborted(); }
  }

  throw new Error(
    'Could not find or download a browser. Install Google Chrome, or set PUPPETEER_EXECUTABLE_PATH to your browser binary.',
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function configureVisiblePage(_page: any): Promise<void> {
  // No-op: auth browser opens at the OS default size with no zoom overrides.
}

function waitForLaunch(promise: Promise<any>, signal?: AbortSignal): Promise<any> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (err) => { cleanup(); reject(err); },
    );
  });
}

async function getScrapeBrowser(signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  if (_scrapeBrowser && _scrapeBrowser.connected) return _scrapeBrowser;

  if (!_scrapeBrowserLaunch) {
    const controller = new AbortController();
    const launch = { controller, waiters: new Set<symbol>() } as ScrapeBrowserLaunch;
    launch.promise = launchBrowser(true, undefined, controller.signal)
      .then(async (browser) => {
        if (controller.signal.aborted || _scrapeBrowserLaunch !== launch) {
          await safeClose(browser);
          controller.signal.throwIfAborted();
          throw new Error('Browser launch was superseded');
        }
        _scrapeBrowser = browser;
        return browser;
      })
      .finally(() => {
        if (_scrapeBrowserLaunch === launch) _scrapeBrowserLaunch = null;
      });
    _scrapeBrowserLaunch = launch;
  }

  const launch = _scrapeBrowserLaunch;
  const waiter = Symbol('scrape-browser-waiter');
  launch.waiters.add(waiter);
  try {
    return await waitForLaunch(launch.promise, signal);
  } finally {
    launch.waiters.delete(waiter);
    if (launch.waiters.size === 0 && _scrapeBrowserLaunch === launch && !_scrapeBrowser) {
      launch.controller.abort(new Error('Browser launch no longer needed'));
    }
  }
}

async function getAuthBrowser(onStatus?: (msg: string) => void, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  if (_authBrowser && _authBrowser.connected) return _authBrowser;

  if (_authBrowserLaunchPromise) {
    return waitForLaunch(_authBrowserLaunchPromise, signal);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const launchPromise = launchBrowser(false, onStatus, controller.signal);
  _authBrowserLaunchPromise = launchPromise;
  _authBrowserLaunchController = controller;
  try {
    const browser = await waitForLaunch(launchPromise, signal);
    if (_authBrowserLaunchPromise !== launchPromise) {
      await safeClose(browser);
      throw new Error('Authentication browser launch was cancelled');
    }
    _authBrowser = browser;
    const pages = await _authBrowser.pages();
    await Promise.all(pages.map((page: any) => configureVisiblePage(page)));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (_authBrowserLaunchPromise === launchPromise) {
      _authBrowserLaunchPromise = null;
      _authBrowserLaunchController = null;
    }
  }
  return _authBrowser;
}

async function closeAuthBrowser(): Promise<void> {
  const launch = _authBrowserLaunchPromise;
  _authBrowserLaunchPromise = null;
  _authBrowserLaunchController?.abort(new Error('Authentication browser closed'));
  _authBrowserLaunchController = null;
  if (launch) await launch.catch(() => {});
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      Promise.resolve(browser.close()).then(() => true, () => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 2_000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!closed) {
      const cancelForceKill = terminateProcessTree(proc?.pid);
      proc?.once?.('exit', cancelForceKill);
      try { browser.disconnect(); } catch { /* ignore */ }
    }
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
    const authLaunch = _authBrowserLaunchPromise;
    _authBrowserLaunchPromise = null;
    _authBrowserLaunchController?.abort(new Error('Browser shutdown'));
    _authBrowserLaunchController = null;
    if (authLaunch) await authLaunch.catch(() => {});

    if (_scrapeBrowser) {
      await safeClose(_scrapeBrowser);
      _scrapeBrowser = null;
    }
    const scrapeLaunch = _scrapeBrowserLaunch;
    _scrapeBrowserLaunch = null;
    if (scrapeLaunch) {
      scrapeLaunch.controller.abort(new Error('Browser shutdown'));
      await scrapeLaunch.promise.catch(() => {});
    }
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
      const proc = typeof _authBrowser.process === 'function' ? _authBrowser.process() : null;
      const cancelForceKill = terminateProcessTree(proc?.pid);
      proc?.once?.('exit', cancelForceKill);
      try {
        _authBrowser.disconnect();
      } catch {
        // ignore
      }
      _authBrowser = null;
    }
    _authBrowserLaunchPromise = null;
    _authBrowserLaunchController?.abort(new Error('Browser handles released'));
    _authBrowserLaunchController = null;

    if (_scrapeBrowser) {
      const proc = typeof _scrapeBrowser.process === 'function' ? _scrapeBrowser.process() : null;
      const cancelForceKill = terminateProcessTree(proc?.pid);
      proc?.once?.('exit', cancelForceKill);
      try {
        _scrapeBrowser.disconnect();
      } catch {
        // ignore
      }
      _scrapeBrowser = null;
    }
    _scrapeBrowserLaunch?.controller.abort(new Error('Browser handles released'));
    _scrapeBrowserLaunch = null;
  } catch {
    // ignore
  }
}

export async function authenticate(
  providerId: string,
  authUrl: string,
  successPattern: string,
  verifyUrl: string,
  onStatus?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!canOpenVisibleBrowser()) {
    onStatus?.('Cannot open auth browser: no display server detected. Set DISPLAY or WAYLAND_DISPLAY.');
    return false;
  }

  const browser = await getAuthBrowser(onStatus, signal);
  onStatus?.('Browser opened. Please log in...');
  const onAbort = () => { void closeAuthBrowser(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  let page: any = null;
  try {
    signal?.throwIfAborted();
    page = (await browser.pages())[0] || await browser.newPage();
    signal?.throwIfAborted();
    await configureVisiblePage(page);
    signal?.throwIfAborted();
    const existingCookies = getCachedCookies(providerId);
    if (existingCookies.length > 0) await page.setCookie(...existingCookies);

    await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 120_000, signal });

    onStatus?.('Waiting for successful login...');
    const timeoutMs = 600_000;
    const pollMs = 1500;
    const start = Date.now();
    let success = false;

    while (Date.now() - start < timeoutMs) {
      signal?.throwIfAborted();
      // Re-acquire active page each tick — handles user closing original tab or OAuth popups taking over.
      try {
        const pages = await browser.pages();
        const activePage = pages.find((p: any) => {
          try { const u = p.url(); return u && u !== 'about:blank'; } catch { return false; }
        });
        if (activePage) page = activePage;
      } catch { signal?.throwIfAborted(); }

      // page.url() / page.cookies() / page.evaluate() all throw during cross-origin OAuth redirects
      // (e.g. "Execution context was destroyed") — treat every transient page error as still waiting.
      let href = '';
      try {
        href = page.url().toLowerCase();
      } catch {
        await delay(pollMs, undefined, { signal });
        continue;
      }

      const hasPattern = href.includes(successPattern.toLowerCase());
      const stillInAuthFlow =
        href.includes('/auth') ||
        href.includes('/login') ||
        href.includes('/signin') ||
        href.includes('/sign-in');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cookies: any[] = [];
      try {
        cookies = await page.cookies();
      } catch {
        await delay(pollMs, undefined, { signal });
        continue;
      }
      const hasSessionCookie = cookies.some((c: { name: string }) =>
        /session|token|auth|next-auth/i.test(c.name),
      );
      const hasSolidSessionCookie = cookies.some((c: { name: string }) =>
        /__secure-next-auth\.session-token|next-auth\.session-token|session-token/i.test(c.name),
      );

      let markers = { hasLoginMarkers: true, hasAppMarkers: false };
      try {
        markers = await page.evaluate(() => {
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
      } catch {
        await delay(pollMs, undefined, { signal });
        continue;
      }

      // Candidate success: auth page left + session-like cookies.
      const candidate = (hasPattern && !stillInAuthFlow && hasSessionCookie) || (hasSolidSessionCookie && !markers.hasLoginMarkers);

      if (candidate) {
        // Strong verification: check protected usage page in a background tab.
        // Bug 2 fix: always close verifyPage in a finally block.
        let verified = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let verifyPage: any = null;
        try {
          verifyPage = await browser.newPage();
          await configureVisiblePage(verifyPage);
          await verifyPage.setCookie(...cookies);
          await verifyPage.goto(verifyUrl, { waitUntil: 'networkidle2', timeout: 60_000, signal });

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
              txt.includes('quota') ||
              txt.includes('rate limit') ||
              txt.includes('token') ||
              txt.includes('request') ||
              txt.includes('credit') ||
              txt.includes('allowance') ||
              txt.includes('capacity') ||
              txt.includes('daily') ||
              txt.includes('weekly') ||
              txt.includes('monthly') ||
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
          signal?.throwIfAborted();
          verified = false;
        } finally {
          if (verifyPage) { try { await verifyPage.close(); } catch { /* ignore */ } }
        }

        if (verified) {
          success = true;
          break;
        }
      }

      await delay(pollMs, undefined, { signal });
    }

    if (!success) {
      onStatus?.('Auth timed out.');
      return false;
    }

    const cookiesFile2 = cookiesPath(providerId);
    const allCookies = await page.cookies();
    const authCookies = allCookies.filter(isAuthCookie);
    // Guard: if the filter strips everything (e.g. unknown provider cookie format), keep all cookies
    // rather than saving an empty array which would silently break auth on next run.
    const cookiesToSave = authCookies.length > 0 ? authCookies : allCookies;
    if (!fs.existsSync(COOKIES_DIR)) {
      fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(cookiesFile2, encryptCookies(cookiesToSave, providerId), { encoding: 'utf-8', mode: 0o600 });
    setRestrictiveFilePerms(cookiesFile2);

    // Clear cookie cache so next scrape loads the fresh cookies from disk.
    _cookiesCache.delete(providerId);

    onStatus?.('Auth successful. Saving session...');
    return true;
  } finally {
    signal?.removeEventListener('abort', onAbort);
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
    const cookies = getCachedCookies(providerId);
    if (cookies.length > 0) await page.setCookie(...cookies);

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

  const cookies = getCachedCookies(providerId);
  if (cookies.length > 0) await page.setCookie(...cookies);

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

  const cookies = getCachedCookies(providerId);
  if (cookies.length > 0) await page.setCookie(...cookies);

  return page;
}

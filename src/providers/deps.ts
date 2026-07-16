import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { getBrowserRuntimeDir } from '../utils/paths.js';

const legacyRequire = createRequire(import.meta.url);
const BROWSER_RUNTIME_DIR = getBrowserRuntimeDir();
const BROWSER_PACKAGES = {
  puppeteer: '^24.0.0',
  'puppeteer-extra': '^3.3.6',
  'puppeteer-extra-plugin-stealth': '^2.11.2',
};

type PuppeteerInstallation = {
  nodeModulesDir: string;
  puppeteerPath: string;
  puppeteerExtraPath: string;
  stealthPluginPath: string;
};

let cachedInstallation: PuppeteerInstallation | null | undefined;
const failedInstallations = new Set<string>();

function resolveInstallation(): PuppeteerInstallation | null {
  if (cachedInstallation !== undefined) return cachedInstallation;

  const runtimeRequire = createRequire(path.join(BROWSER_RUNTIME_DIR, 'package.json'));
  const candidates = [
    { rootDir: BROWSER_RUNTIME_DIR, resolver: runtimeRequire },
    { rootDir: getToolDir(), resolver: legacyRequire },
  ];

  for (const candidate of candidates) {
    try {
      const puppeteerPath = candidate.resolver.resolve('puppeteer');
      let packageDir = path.dirname(puppeteerPath);
      while (path.dirname(packageDir) !== packageDir) {
        const manifest = path.join(packageDir, 'package.json');
        if (fs.existsSync(manifest)) {
          try {
            if ((JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }).name === 'puppeteer') break;
          } catch { /* keep walking */ }
        }
        packageDir = path.dirname(packageDir);
      }
      cachedInstallation = {
        nodeModulesDir: path.dirname(packageDir),
        puppeteerPath,
        puppeteerExtraPath: candidate.resolver.resolve('puppeteer-extra'),
        stealthPluginPath: candidate.resolver.resolve('puppeteer-extra-plugin-stealth'),
      };
      if (failedInstallations.has(cachedInstallation.nodeModulesDir)) {
        cachedInstallation = undefined;
        continue;
      }
      return cachedInstallation;
    } catch {
      // Try the next supported installation location.
    }
  }

  cachedInstallation = null;
  return null;
}

export function isPuppeteerInstalled(): boolean {
  return resolveInstallation() !== null;
}

export async function loadPuppeteerModules(): Promise<{
  puppeteer: any;
  puppeteerExtra: any;
  StealthPlugin: any;
}> {
  const installation = resolveInstallation();
  if (!installation) throw new Error('Puppeteer browser runtime is not installed');

  let puppeteerModule: any;
  let extraModule: any;
  let stealthModule: any;
  try {
    [puppeteerModule, extraModule, stealthModule] = await Promise.all([
      import(pathToFileURL(installation.puppeteerPath).href),
      import(pathToFileURL(installation.puppeteerExtraPath).href),
      import(pathToFileURL(installation.stealthPluginPath).href),
    ]);
  } catch (err) {
    failedInstallations.add(installation.nodeModulesDir);
    cachedInstallation = undefined;
    if (resolveInstallation()) return loadPuppeteerModules();
    throw err;
  }

  const modules = {
    puppeteer: puppeteerModule.default ?? puppeteerModule,
    puppeteerExtra: extraModule.default ?? extraModule,
    StealthPlugin: stealthModule.default ?? stealthModule,
  };
  if (
    typeof modules.puppeteer?.executablePath !== 'function' ||
    typeof modules.puppeteerExtra?.use !== 'function' ||
    typeof modules.puppeteerExtra?.launch !== 'function' ||
    typeof modules.StealthPlugin !== 'function'
  ) {
    failedInstallations.add(installation.nodeModulesDir);
    cachedInstallation = undefined;
    if (resolveInstallation()) return loadPuppeteerModules();
    throw new Error('Puppeteer browser runtime is incomplete or incompatible');
  }
  return modules;
}

export async function isPuppeteerUsable(): Promise<boolean> {
  if (!isPuppeteerInstalled()) return false;
  try {
    await loadPuppeteerModules();
    return true;
  } catch {
    return false;
  }
}

export async function getPuppeteerBrowserPath(): Promise<string | null> {
  try {
    const { puppeteer } = await loadPuppeteerModules();
    const executablePath = puppeteer.executablePath();
    return typeof executablePath === 'string' && fs.existsSync(executablePath) ? executablePath : null;
  } catch {
    return null;
  }
}

export function getPuppeteerBinPath(): string | null {
  const installation = resolveInstallation();
  if (!installation) return null;
  const executable = process.platform === 'win32' ? 'puppeteer.cmd' : 'puppeteer';
  const candidates = [path.join(installation.nodeModulesDir, '.bin', executable)];
  if (process.platform === 'win32') {
    candidates.push(path.join(path.dirname(installation.nodeModulesDir), executable));
  } else if (path.basename(path.dirname(installation.nodeModulesDir)) === 'lib') {
    candidates.push(path.join(path.dirname(path.dirname(installation.nodeModulesDir)), 'bin', executable));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function getToolDir(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = path.resolve(path.dirname(here), '..', '..');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // fallback below
  }
  return process.cwd();
}

function isElectron(): boolean {
  return !!(process.versions as Record<string, string | undefined>)['electron'];
}

function getCandidateNpmPaths(): string[] {
  if (isElectron()) return [];

  const paths: string[] = [];
  const nodeDir = path.dirname(process.execPath);

  paths.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));

  if (process.platform === 'darwin') {
    paths.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  if (process.platform === 'linux') {
    paths.push('/usr/lib/node_modules/npm/bin/npm-cli.js');
  }

  return paths.filter(p => fs.existsSync(p));
}

type Attempt = { cmd: string; args: string[]; label: string };

export function terminateProcessTree(pid: number | undefined): () => void {
  if (!pid) return () => {};
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    killer.unref();
    return () => {};
  }
  try {
    process.kill(-pid, 'SIGTERM');
    const forceKill = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* process group exited */ }
    }, 1_000);
    forceKill.unref();
    return () => clearTimeout(forceKill);
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
    return () => {};
  }
}

async function runInstallAttempt(
  attempt: Attempt,
  cwd: string,
  env: Record<string, string>,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  onProgress?.(`Trying: ${attempt.label}`);
  onProgress?.(`Command: ${attempt.cmd} ${attempt.args.join(' ')}`);

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelForceKill: (() => void) | undefined;
    const child = spawn(attempt.cmd, attempt.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: attempt.cmd === 'npm' || (process.platform === 'win32' && attempt.cmd.toLowerCase().endsWith('.cmd')),
      detached: process.platform !== 'win32',
    });
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (abortTimer) clearTimeout(abortTimer);
      cancelForceKill?.();
    };
    const onAbort = () => {
      cancelForceKill = terminateProcessTree(child.pid);
      abortTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(signal?.reason);
      }, 2_000);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => {
      const lines = d.toString().split('\n').filter(Boolean);
      for (const l of lines) onProgress?.(l);
    });

    child.stderr.on('data', (d: Buffer) => {
      const lines = d.toString().split('\n').filter(Boolean);
      for (const l of lines) {
        if (!l.includes('WARN') && !l.includes('deprecated') && !l.includes('warn')) {
          onProgress?.(l);
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      onProgress?.(`Attempt failed to start: ${err.message}`);
      resolve(false);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (code === 0) {
        resolve(true);
      } else {
        onProgress?.(`Attempt exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

async function installPuppeteerBrowser(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (await getPuppeteerBrowserPath()) return true;
  const puppeteerBin = getPuppeteerBinPath();
  if (!puppeteerBin) {
    onProgress?.('Puppeteer CLI was not found after package installation.');
    return false;
  }

  const env = { ...process.env } as Record<string, string>;
  delete env['PUPPETEER_SKIP_DOWNLOAD'];
  delete env['PUPPETEER_SKIP_CHROMIUM_DOWNLOAD'];
  onProgress?.('Installing Chrome for Testing (one-time download)...');
  const ok = await runInstallAttempt({
    cmd: puppeteerBin,
    args: ['browsers', 'install', 'chrome'],
    label: 'Puppeteer browser installer',
  }, BROWSER_RUNTIME_DIR, env, onProgress, signal);
  signal?.throwIfAborted();
  if (!ok) return false;

  const browserPath = await getPuppeteerBrowserPath();
  if (!browserPath) {
    onProgress?.('Browser download completed, but Puppeteer could not resolve its executable.');
    return false;
  }
  onProgress?.(`Browser ready: ${browserPath}`);
  return true;
}

export async function installPuppeteer(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (await isPuppeteerUsable()) {
    if (await getPuppeteerBrowserPath()) {
      onProgress?.('Puppeteer browser runtime is already installed.');
      return true;
    }
    onProgress?.('Puppeteer packages are already installed; only the browser is missing.');
    return installPuppeteerBrowser(onProgress, signal);
  }

  const cwd = BROWSER_RUNTIME_DIR;
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'agwatch-browser-runtime',
    private: true,
    version: '1.0.0',
    dependencies: BROWSER_PACKAGES,
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  const npmCliPaths = getCandidateNpmPaths();

  onProgress?.(`Platform: ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}`);
  onProgress?.(`Install cwd: ${cwd}`);
  onProgress?.(`Node execPath: ${process.execPath}`);

  const env = { ...process.env } as Record<string, string>;
  delete env['PUPPETEER_SKIP_DOWNLOAD'];
  delete env['PUPPETEER_SKIP_CHROMIUM_DOWNLOAD'];

  const installArgs = ['install', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'];

  const attempts: Attempt[] = [];
  for (const npmCli of npmCliPaths) {
    attempts.push({
      cmd: process.execPath,
      args: [npmCli, ...installArgs],
      label: `${path.basename(process.execPath)} + ${npmCli}`,
    });
    attempts.push({
      cmd: 'node',
      args: [npmCli, ...installArgs],
      label: `node (PATH) + ${npmCli}`,
    });
  }
  attempts.push({
    cmd: 'npm',
    args: installArgs,
    label: 'npm (PATH)',
  });

  for (const attempt of attempts) {
    const ok = await runInstallAttempt(attempt, cwd, env, onProgress, signal);
    signal?.throwIfAborted();
    if (ok) {
      cachedInstallation = undefined;
      failedInstallations.clear();
      if (await isPuppeteerUsable()) {
        onProgress?.('Puppeteer packages installed successfully.');
        return installPuppeteerBrowser(onProgress, signal);
      }
      onProgress?.('Installation completed but the browser runtime could not be loaded.');
    }
  }

  onProgress?.('All install attempts failed.');
  return false;
}

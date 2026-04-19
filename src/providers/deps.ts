import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.url);

export function isPuppeteerInstalled(): boolean {
  try {
    req.resolve('puppeteer');
    req.resolve('puppeteer-extra');
    req.resolve('puppeteer-extra-plugin-stealth');
    return true;
  } catch {
    return false;
  }
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

async function runInstallAttempt(
  attempt: Attempt,
  cwd: string,
  env: Record<string, string>,
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  onProgress?.(`Trying: ${attempt.label}`);
  onProgress?.(`Command: ${attempt.cmd} ${attempt.args.join(' ')}`);

  return new Promise<boolean>((resolve) => {
    const child = spawn(attempt.cmd, attempt.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: attempt.cmd === 'npm',
    });

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
      onProgress?.(`Attempt failed to start: ${err.message}`);
      resolve(false);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        onProgress?.(`Attempt exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

export async function installPuppeteer(
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  const toolDir = getToolDir();
  const cwd = fs.existsSync(toolDir) ? toolDir : process.cwd();
  const packages = ['puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'];
  const npmCliPaths = getCandidateNpmPaths();

  onProgress?.(`Platform: ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}`);
  onProgress?.(`Install cwd: ${cwd}`);
  onProgress?.(`Node execPath: ${process.execPath}`);

  const env = { ...process.env } as Record<string, string>;
  delete env['PUPPETEER_SKIP_DOWNLOAD'];
  delete env['PUPPETEER_SKIP_CHROMIUM_DOWNLOAD'];

  const installArgs = ['install', ...packages, '--no-save', '--legacy-peer-deps'];

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
    const ok = await runInstallAttempt(attempt, cwd, env, onProgress);
    if (ok) {
      onProgress?.('Puppeteer installed successfully.');
      return true;
    }
  }

  onProgress?.('All install attempts failed.');
  return false;
}

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TimeRange } from '../domain/types.js';
import type { FallbackMode } from '../providers/runtime-options.js';

export type CliArgs = {
  command: 'summary' | 'dashboard';
  range?: TimeRange;
  from?: string;
  to?: string;
  json?: boolean;
  watch?: boolean;
  providerDebug?: boolean;
  providerStartupTimeoutMs?: number;
  providerManualTimeoutMs?: number;
  providerFallback?: FallbackMode;
};

function getCliVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = path.resolve(here, '../../package.json');
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function parseArgs(): CliArgs {
  let result: CliArgs = { command: 'dashboard' };

  const program = new Command();

  program
    .name('agwatch')
    .description('AI Usage CLI Dashboard')
    .version(getCliVersion())
    .option('--range <range>', 'Time range: today, 7d, 30d, month', '7d')
    .option('--watch', 'Enable auto-refresh')
    .option('--provider-debug', 'Enable provider debug mode')
    .option('--provider-startup-timeout-ms <ms>', 'Provider startup timeout in milliseconds')
    .option('--provider-manual-timeout-ms <ms>', 'Provider manual refresh timeout in milliseconds')
    .option('--provider-fallback <mode>', 'Provider fallback: never, on_auth_error, on_any_error')
    .action((opts) => {
      result = {
        command: 'dashboard',
        range: validateRange(opts.range),
        watch: opts.watch ?? false,
        providerDebug: opts.providerDebug ?? undefined,
        providerStartupTimeoutMs: parsePositiveInt(opts.providerStartupTimeoutMs),
        providerManualTimeoutMs: parsePositiveInt(opts.providerManualTimeoutMs),
        providerFallback: validateFallbackMode(opts.providerFallback),
      };
    });

  program
    .command('summary')
    .description('Show usage summary')
    .option('--range <range>', 'Time range: today, 7d, 30d, month', '7d')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      result = {
        command: 'summary',
        range: validateRange(opts.range),
        from: opts.from,
        to: opts.to,
        json: opts.json ?? false,
      };
    });

  program
    .command('dashboard')
    .description('Interactive usage dashboard (default)')
    .option('--range <range>', 'Time range: today, 7d, 30d, month', '7d')
    .option('--watch', 'Enable auto-refresh')
    .option('--provider-debug', 'Enable provider debug mode')
    .option('--provider-startup-timeout-ms <ms>', 'Provider startup timeout in milliseconds')
    .option('--provider-manual-timeout-ms <ms>', 'Provider manual refresh timeout in milliseconds')
    .option('--provider-fallback <mode>', 'Provider fallback: never, on_auth_error, on_any_error')
    .action((opts) => {
      result = {
        command: 'dashboard',
        range: validateRange(opts.range),
        watch: opts.watch ?? false,
        providerDebug: opts.providerDebug ?? undefined,
        providerStartupTimeoutMs: parsePositiveInt(opts.providerStartupTimeoutMs),
        providerManualTimeoutMs: parsePositiveInt(opts.providerManualTimeoutMs),
        providerFallback: validateFallbackMode(opts.providerFallback),
      };
    });

  program.parse();

  return result;
}

function validateRange(range: string | undefined): TimeRange | undefined {
  const valid: TimeRange[] = ['today', '7d', '30d', 'month'];
  if (range && valid.includes(range as TimeRange)) return range as TimeRange;
  return undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function validateFallbackMode(raw: string | undefined): FallbackMode | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v === 'never' || v === 'on_auth_error' || v === 'on_any_error') {
    return v;
  }
  return undefined;
}

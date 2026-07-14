import { Command, InvalidArgumentError } from 'commander';
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

export function parseArgs(argv: readonly string[] = process.argv): CliArgs {
  let result: CliArgs = { command: 'dashboard' };

  const program = new Command();
  program.configureHelp({ showGlobalOptions: true });

  program
    .name('agwatch')
    .description('AI Usage CLI Dashboard')
    .version(getCliVersion())
    .option('--range <range>', 'Time range: today, 7d, 30d, month', parseRange, '7d')
    .option('--watch', 'Enable auto-refresh')
    .option('--provider-debug', 'Enable provider debug mode')
    .option('--provider-startup-timeout-ms <ms>', 'Provider startup timeout in milliseconds', parsePositiveInt)
    .option('--provider-manual-timeout-ms <ms>', 'Provider manual refresh timeout in milliseconds', parsePositiveInt)
    .option('--provider-fallback <mode>', 'Provider fallback: never, on_auth_error, on_any_error', parseFallbackMode)
    .action((opts) => {
      result = {
        command: 'dashboard',
        range: opts.range,
        watch: opts.watch ?? false,
        providerDebug: opts.providerDebug ?? undefined,
        providerStartupTimeoutMs: opts.providerStartupTimeoutMs,
        providerManualTimeoutMs: opts.providerManualTimeoutMs,
        providerFallback: opts.providerFallback,
      };
    });

  program
    .command('summary')
    .description('Show usage summary')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const globals = program.opts();
      result = {
        command: 'summary',
        range: globals.range,
        from: opts.from,
        to: opts.to,
        json: opts.json ?? false,
      };
    });

  program
    .command('dashboard')
    .description('Interactive usage dashboard (default)')
    .action(() => {
      const opts = program.opts();
      result = {
        command: 'dashboard',
        range: opts.range,
        watch: opts.watch ?? false,
        providerDebug: opts.providerDebug ?? undefined,
        providerStartupTimeoutMs: opts.providerStartupTimeoutMs,
        providerManualTimeoutMs: opts.providerManualTimeoutMs,
        providerFallback: opts.providerFallback,
      };
    });

  program.parse([...argv]);

  return result;
}

function parseRange(range: string): TimeRange {
  const valid: TimeRange[] = ['today', '7d', '30d', 'month'];
  if (valid.includes(range as TimeRange)) return range as TimeRange;
  throw new InvalidArgumentError(`expected one of: ${valid.join(', ')}`);
}

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return n;
}

function parseFallbackMode(raw: string): FallbackMode {
  const v = raw.toLowerCase();
  if (v === 'never' || v === 'on_auth_error' || v === 'on_any_error') {
    return v;
  }
  throw new InvalidArgumentError('expected one of: never, on_auth_error, on_any_error');
}

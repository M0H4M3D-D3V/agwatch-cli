import type { TimeRange } from '../../domain/types.js';
import { runInkDashboard } from '../../tui/app.js';
import { setProviderRuntimeOptions } from '../../providers/runtime-options.js';
import type { FallbackMode } from '../../providers/runtime-options.js';

export async function runDashboardCommand(opts: {
  range?: TimeRange;
  watch?: boolean;
  providerDebug?: boolean;
  providerStartupTimeoutMs?: number;
  providerManualTimeoutMs?: number;
  providerFallback?: FallbackMode;
}): Promise<void> {
  setProviderRuntimeOptions({
    debug: opts.providerDebug,
    startupTimeoutMs: opts.providerStartupTimeoutMs,
    manualTimeoutMs: opts.providerManualTimeoutMs,
    fallbackMode: opts.providerFallback,
  });

  const range = opts.range ?? '7d';
  const refreshSeconds = opts.watch ? 3 : undefined;
  await runInkDashboard(range, 'all', refreshSeconds);
}

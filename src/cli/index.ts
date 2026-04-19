#!/usr/bin/env node

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  process.stderr.write(`agwatch requires Node.js 18 or later. Current: ${process.version}\n`);
  process.exit(1);
}

import { parseArgs } from './parse-args.js';
import { runSummary } from './commands/summary.js';
import { runDashboardCommand } from './commands/dashboard.js';
import { handleError } from '../utils/errors.js';

async function main() {
  const args = parseArgs();

  if (args.command === 'summary') {
    await runSummary({
      range: args.range,
      from: args.from,
      to: args.to,
      json: args.json,
    });
  } else {
    await runDashboardCommand({
      range: args.range,
      watch: args.watch,
      providerDebug: args.providerDebug,
      providerStartupTimeoutMs: args.providerStartupTimeoutMs,
      providerManualTimeoutMs: args.providerManualTimeoutMs,
      providerFallback: args.providerFallback,
    });
  }
}

main().catch(handleError);

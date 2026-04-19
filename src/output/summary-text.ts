import type { SummaryMetrics, AggregateRow, DailyRow } from '../domain/types.js';
import { formatMoney, formatInt, formatTokenCount, formatPercent, padRight, padLeft, renderProgressBar } from '../utils/format.js';
import { formatDayShort } from '../utils/dates.js';
import chalk from 'chalk';

export function renderSummaryText(
  rangeLabel: string,
  summary: SummaryMetrics,
  dailyActivity: DailyRow[],
  byProject: AggregateRow[],
  byActivity: AggregateRow[],
  byModel: AggregateRow[],
): string {
  const lines: string[] = [];

  lines.push(chalk.bold.cyan(`agwatch summary`) + chalk.gray(` | ${rangeLabel}`));
  lines.push('');

  lines.push(chalk.bold('Summary'));
  lines.push(`  Cost:           ${chalk.green(formatMoney(summary.totalCost))}`);
  lines.push(`  Calls:          ${formatInt(summary.totalCalls)}`);
  lines.push(`  Sessions:       ${formatInt(summary.totalSessions)}`);
  lines.push(`  Cache Hit Rate: ${formatPercent(summary.cacheHitRate)}`);
  lines.push(`  Input Tokens:   ${formatTokenCount(summary.inputTokens)}`);
  lines.push(`  Output Tokens:  ${formatTokenCount(summary.outputTokens)}`);
  lines.push(`  Cached Tokens:  ${formatTokenCount(summary.cachedTokens)}`);
  lines.push(`  Written Tokens: ${formatTokenCount(summary.writtenTokens)}`);
  lines.push('');

  if (byModel.length > 0) {
    lines.push(chalk.bold('By Model'));
    lines.push(`  ${padRight('Model', 28)} ${padLeft('In', 8)} ${padLeft('Out', 8)} ${padLeft('Cost', 10)} ${padLeft('Calls', 8)} Progress`);
    lines.push(`  ${'─'.repeat(28)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(15)}`);
    for (const r of byModel.slice(0, 10)) {
      lines.push(`  ${padRight(r.name, 28)} ${padLeft(formatTokenCount(r.inputTokens), 8)} ${padLeft(formatTokenCount(r.outputTokens), 8)} ${padLeft(formatMoney(r.costUsd), 10)} ${padLeft(formatInt(r.calls), 8)} ${renderProgressBar(r.percentOfMax, 15)}`);
    }
    lines.push('');
  }

  if (byProject.length > 0) {
    lines.push(chalk.bold('By Project'));
    lines.push(`  ${padRight('Project', 22)} ${padLeft('In', 8)} ${padLeft('Out', 8)} ${padLeft('Cost', 10)} ${padLeft('Sess', 6)} Progress`);
    lines.push(`  ${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(15)}`);
    for (const r of byProject.slice(0, 10)) {
      lines.push(`  ${padRight(r.name, 22)} ${padLeft(formatTokenCount(r.inputTokens), 8)} ${padLeft(formatTokenCount(r.outputTokens), 8)} ${padLeft(formatMoney(r.costUsd), 10)} ${padLeft(formatInt(r.sessions), 6)} ${renderProgressBar(r.percentOfMax, 15)}`);
    }
    lines.push('');
  }

  if (dailyActivity.length > 0) {
    lines.push(chalk.bold('Daily Activity'));
    lines.push(`  ${padRight('Day', 12)} ${padLeft('Tokens In', 10)} ${padLeft('Tokens Out', 11)} ${padLeft('Cost', 12)} ${padLeft('Calls', 8)} Progress`);
    lines.push(`  ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(11)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(15)}`);
    for (const r of dailyActivity) {
      lines.push(`  ${padRight(formatDayShort(r.day), 12)} ${padLeft(formatTokenCount(r.inputTokens), 10)} ${padLeft(formatTokenCount(r.outputTokens), 11)} ${padLeft(formatMoney(r.costUsd), 12)} ${padLeft(formatInt(r.calls), 8)} ${renderProgressBar(r.percentOfMax, 15)}`);
    }
    lines.push('');
  }

  if (byActivity.length > 0) {
    lines.push(chalk.bold('By Activity'));
    lines.push(`  ${padRight('Activity', 18)} ${padLeft('Cost', 12)} ${padLeft('Calls', 8)} Progress`);
    lines.push(`  ${'─'.repeat(18)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(15)}`);
    for (const r of byActivity.slice(0, 10)) {
      lines.push(`  ${padRight(r.name, 18)} ${padLeft(formatMoney(r.costUsd), 12)} ${padLeft(formatInt(r.calls), 8)} ${renderProgressBar(r.percentOfMax, 15)}`);
    }
  }

  return lines.join('\n');
}

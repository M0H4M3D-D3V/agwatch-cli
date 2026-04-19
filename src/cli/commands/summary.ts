import type { TimeRange } from '../../domain/types.js';
import { resolveTimeRange } from '../../config/ranges.js';
import { loadUsageEvents } from '../../services/load-usage-events.js';
import { aggregateSummary } from '../../services/aggregate-summary.js';
import { aggregateByDay, aggregateByProject, aggregateByActivity, aggregateByModel, aggregateByTool, aggregateByShellCommand, aggregateByMcpServer } from '../../services/aggregate-panels.js';
import { renderSummaryText } from '../../output/summary-text.js';
import { renderSummaryJson } from '../../output/summary-json.js';

export async function runSummary(opts: {
  range?: TimeRange;
  from?: string;
  to?: string;
  json?: boolean;
}): Promise<void> {
  const filter = resolveTimeRange(opts.range, opts.from, opts.to);
  const events = await loadUsageEvents(filter);

  if (events.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'No usage records found for selected range', metadata: { range: filter.label } }, null, 2));
    } else {
      console.log('No usage records found for selected range.');
    }
    return;
  }

  const summary = aggregateSummary(events);
  const dailyActivity = aggregateByDay(events);
  const byProject = aggregateByProject(events);
  const byActivity = aggregateByActivity(events);
  const byModel = aggregateByModel(events);
  const tools = aggregateByTool(events);
  const shellCommands = aggregateByShellCommand(events);
  const mcpServers = aggregateByMcpServer(events);

  if (opts.json) {
    const output = renderSummaryJson(
      'opencode',
      filter.label,
      opts.from,
      opts.to,
      summary,
      dailyActivity,
      byProject,
      byActivity,
      byModel,
      tools,
      shellCommands,
      mcpServers,
    );
    console.log(output);
  } else {
    const output = renderSummaryText(filter.label, summary, dailyActivity, byProject, byActivity, byModel);
    console.log(output);
  }
}

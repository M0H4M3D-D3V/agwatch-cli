import type { SummaryJsonOutput, SummaryMetrics, DailyRow, AggregateRow } from '../domain/types.js';

export function renderSummaryJson(
  agent: string,
  rangeLabel: string,
  from: string | undefined,
  to: string | undefined,
  summary: SummaryMetrics,
  dailyActivity: DailyRow[],
  byProject: AggregateRow[],
  byActivity: AggregateRow[],
  byModel: AggregateRow[],
  tools: AggregateRow[],
  shellCommands: AggregateRow[],
  mcpServers: AggregateRow[],
): string {
  const output: SummaryJsonOutput = {
    metadata: {
      agent,
      range: rangeLabel,
      from,
      to,
      generatedAt: new Date().toISOString(),
    },
    summary,
    panels: {
      dailyActivity,
      byProject,
      byActivity,
      byModel,
      tools,
      shellCommands,
      mcpServers,
    },
  };

  return JSON.stringify(output, null, 2);
}

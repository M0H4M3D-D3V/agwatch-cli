import type { TimeRange, DashboardData } from '../domain/types.js';
import { resolveTimeRange } from '../config/ranges.js';
import { loadUsageEvents } from './load-usage-events.js';
import { aggregateSummary } from './aggregate-summary.js';
import { aggregateByDay, aggregateByProject, aggregateByActivity, aggregateByModel, aggregateByTool, aggregateByShellCommand, aggregateByMcpServer } from './aggregate-panels.js';

export async function loadDataForRange(range: TimeRange, agentId?: string): Promise<DashboardData> {
  const filter = resolveTimeRange(range);
  const events = await loadUsageEvents(filter, agentId);

  if (events.length === 0) {
    return {
      summary: { totalCost: 0, totalCalls: 0, totalSessions: 0, cacheHitRate: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, writtenTokens: 0 },
      dailyActivity: [],
      byProject: [],
      byActivity: [],
      byModel: [],
      tools: [],
      shellCommands: [],
      mcpServers: [],
    };
  }

  return {
    summary: aggregateSummary(events),
    dailyActivity: aggregateByDay(events),
    byProject: aggregateByProject(events),
    byActivity: aggregateByActivity(events),
    byModel: aggregateByModel(events),
    tools: aggregateByTool(events),
    shellCommands: aggregateByShellCommand(events),
    mcpServers: aggregateByMcpServer(events),
  };
}

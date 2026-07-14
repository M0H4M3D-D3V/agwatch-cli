import type { UsageEvent, SummaryMetrics } from '../domain/types.js';
import { unique } from '../utils/group.js';
import { nonNegativeNumber } from '../utils/numbers.js';

export function aggregateSummary(events: UsageEvent[]): SummaryMetrics {
  if (events.length === 0) {
    return {
      totalCost: 0,
      totalCalls: 0,
      totalSessions: 0,
      cacheHitRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      writtenTokens: 0,
    };
  }

  const totalCost = events.reduce((sum, e) => sum + nonNegativeNumber(e.costUsd), 0);
  const totalCalls = events.reduce((sum, e) => sum + nonNegativeNumber(e.callCount), 0);
  const sessionIds = unique(events.map((e) => JSON.stringify([e.agentId, e.sessionId])));
  const cacheHitRate = totalCalls > 0
    ? (events.filter((e) => e.cachedTokens > 0).length / totalCalls) * 100
    : 0;

  return {
    totalCost,
    totalCalls,
    totalSessions: sessionIds.length,
    cacheHitRate: Math.min(cacheHitRate, 100),
    inputTokens: events.reduce((sum, e) => sum + nonNegativeNumber(e.inputTokens), 0),
    outputTokens: events.reduce((sum, e) => sum + nonNegativeNumber(e.outputTokens), 0),
    cachedTokens: events.reduce((sum, e) => sum + nonNegativeNumber(e.cachedTokens), 0),
    writtenTokens: events.reduce((sum, e) => sum + nonNegativeNumber(e.writtenTokens), 0),
  };
}

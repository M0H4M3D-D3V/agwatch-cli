import type { UsageEvent, AggregateRow, DailyRow } from '../domain/types.js';
import { groupBy, unique } from '../utils/group.js';
import { toDayKey } from '../utils/dates.js';
import { nonNegativeNumber } from '../utils/numbers.js';

function computePercentOfMax(rows: { value: number }[]): number[] {
  const maxVal = Math.max(...rows.map((r) => nonNegativeNumber(r.value)), 0);
  return rows.map((r) => (maxVal > 0 ? (nonNegativeNumber(r.value) / maxVal) * 100 : 0));
}

function sumBy(items: UsageEvent[], selector: (event: UsageEvent) => number): number {
  return items.reduce((sum, event) => sum + nonNegativeNumber(selector(event)), 0);
}

export function aggregateByDay(events: UsageEvent[]): DailyRow[] {
  const groups = groupBy(events, (e) => toDayKey(e.ts));
  const rows: (Omit<DailyRow, 'sessions' | 'percentOfMax'> & { value: number; sessions: string[] })[] = [];

  for (const [day, items] of groups) {
    rows.push({
      name: day,
      day,
      value: sumBy(items, (e) => e.costUsd),
      inputTokens: sumBy(items, (e) => e.inputTokens),
      outputTokens: sumBy(items, (e) => e.outputTokens),
      cachedTokens: sumBy(items, (e) => e.cachedTokens),
      writtenTokens: sumBy(items, (e) => e.writtenTokens),
      costUsd: sumBy(items, (e) => e.costUsd),
      calls: sumBy(items, (e) => e.callCount),
      sessions: items.map((e) => JSON.stringify([e.agentId, e.sessionId])),
    });
  }

  rows.sort((a, b) => a.day.localeCompare(b.day));

  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.day,
    day: r.day,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedTokens: r.cachedTokens,
    writtenTokens: r.writtenTokens,
    costUsd: r.costUsd,
    calls: r.calls,
    sessions: unique(r.sessions).length,
    percentOfMax: pcts[i],
  }));
}

export function aggregateByProject(events: UsageEvent[]): AggregateRow[] {
  const groups = groupBy(events, (e) => e.project);
  const rows: { name: string; value: number }[] = [];

  for (const [project, items] of groups) {
    rows.push({
      name: project,
      value: sumBy(items, (e) => e.costUsd),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => {
    const items = groups.get(r.name) ?? [];
    return {
      name: r.name,
      inputTokens: sumBy(items, (e) => e.inputTokens),
      outputTokens: sumBy(items, (e) => e.outputTokens),
      cachedTokens: sumBy(items, (e) => e.cachedTokens),
      writtenTokens: sumBy(items, (e) => e.writtenTokens),
      costUsd: sumBy(items, (e) => e.costUsd),
      calls: sumBy(items, (e) => e.callCount),
      sessions: unique(items.map((e) => JSON.stringify([e.agentId, e.sessionId]))).length,
      percentOfMax: pcts[i],
    };
  });
}

export function aggregateByActivity(events: UsageEvent[]): AggregateRow[] {
  const groups = groupBy(events, (e) => e.activity);
  const rows: { name: string; value: number }[] = [];

  for (const [activity, items] of groups) {
    rows.push({
      name: activity,
      value: sumBy(items, (e) => e.costUsd),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => {
    const items = groups.get(r.name) ?? [];
    return {
      name: r.name,
      inputTokens: sumBy(items, (e) => e.inputTokens),
      outputTokens: sumBy(items, (e) => e.outputTokens),
      cachedTokens: sumBy(items, (e) => e.cachedTokens),
      writtenTokens: sumBy(items, (e) => e.writtenTokens),
      costUsd: sumBy(items, (e) => e.costUsd),
      calls: sumBy(items, (e) => e.callCount),
      sessions: 0,
      percentOfMax: pcts[i],
    };
  });
}

export function aggregateByModel(events: UsageEvent[]): AggregateRow[] {
  const groups = groupBy(events, (e) => e.model);
  const rows: { name: string; value: number }[] = [];

  for (const [model, items] of groups) {
    rows.push({
      name: model,
      value: sumBy(items, (e) => e.costUsd),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => {
    const items = groups.get(r.name) ?? [];
    return {
      name: r.name,
      inputTokens: sumBy(items, (e) => e.inputTokens),
      outputTokens: sumBy(items, (e) => e.outputTokens),
      cachedTokens: sumBy(items, (e) => e.cachedTokens),
      writtenTokens: sumBy(items, (e) => e.writtenTokens),
      costUsd: sumBy(items, (e) => e.costUsd),
      calls: sumBy(items, (e) => e.callCount),
      sessions: 0,
      percentOfMax: pcts[i],
    };
  });
}

export function aggregateByTool(events: UsageEvent[]): AggregateRow[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.toolNames?.length) {
      for (const tool of event.toolNames) {
        counts.set(tool, (counts.get(tool) ?? 0) + 1);
      }
    } else if (event.toolName) {
      counts.set(event.toolName, (counts.get(event.toolName) ?? 0) + nonNegativeNumber(event.callCount));
    }
  }

  const rows = [...counts].map(([name, value]) => ({ name, value }));
  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    writtenTokens: 0,
    costUsd: 0,
    calls: r.value,
    sessions: 0,
    percentOfMax: pcts[i],
  }));
}

export function aggregateByShellCommand(events: UsageEvent[]): AggregateRow[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.shellCommands?.length) {
      for (const command of event.shellCommands) counts.set(command, (counts.get(command) ?? 0) + 1);
    } else if (event.shellCommand) {
      counts.set(event.shellCommand, (counts.get(event.shellCommand) ?? 0) + nonNegativeNumber(event.callCount));
    }
  }

  const rows = [...counts].map(([name, value]) => ({ name, value }));
  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    writtenTokens: 0,
    costUsd: 0,
    calls: r.value,
    sessions: 0,
    percentOfMax: pcts[i],
  }));
}

export function aggregateByMcpServer(events: UsageEvent[]): AggregateRow[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.mcpServers?.length) {
      for (const server of event.mcpServers) counts.set(server, (counts.get(server) ?? 0) + 1);
    } else if (event.mcpServer) {
      counts.set(event.mcpServer, (counts.get(event.mcpServer) ?? 0) + nonNegativeNumber(event.callCount));
    }
  }

  const rows = [...counts].map(([name, value]) => ({ name, value }));
  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    writtenTokens: 0,
    costUsd: 0,
    calls: r.value,
    sessions: 0,
    percentOfMax: pcts[i],
  }));
}

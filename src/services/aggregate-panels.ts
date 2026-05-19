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
  const rows: { name: string; day: string; value: number; inputTokens: number; outputTokens: number; cachedTokens: number; writtenTokens: number; costUsd: number; calls: number; sessions: string[] }[] = [];

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
      sessions: items.map((e) => e.sessionId),
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
      sessions: unique(items.map((e) => e.sessionId)).length,
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
  const toolEvents = events.filter((e) => e.toolName);
  const groups = groupBy(toolEvents, (e) => e.toolName!);
  const rows: { name: string; value: number }[] = [];

  for (const [tool, items] of groups) {
    rows.push({
      name: tool,
      value: sumBy(items, (e) => e.callCount),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    writtenTokens: 0,
    costUsd: 0,
    calls: sumBy(groups.get(r.name)!, (e) => e.callCount),
    sessions: 0,
    percentOfMax: pcts[i],
  }));
}

export function aggregateByShellCommand(events: UsageEvent[]): AggregateRow[] {
  const cmdEvents = events.filter((e) => e.shellCommand);
  const groups = groupBy(cmdEvents, (e) => e.shellCommand!);
  const rows: { name: string; value: number }[] = [];

  for (const [cmd, items] of groups) {
    rows.push({
      name: cmd,
      value: sumBy(items, (e) => e.callCount),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    writtenTokens: 0,
    costUsd: 0,
    calls: sumBy(groups.get(r.name)!, (e) => e.callCount),
    sessions: 0,
    percentOfMax: pcts[i],
  }));
}

export function aggregateByMcpServer(events: UsageEvent[]): AggregateRow[] {
  const mcpEvents = events.filter((e) => e.mcpServer);
  const groups = groupBy(mcpEvents, (e) => e.mcpServer!);
  const rows: { name: string; value: number }[] = [];

  for (const [server, items] of groups) {
    rows.push({
      name: server,
      value: sumBy(items, (e) => e.callCount),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    writtenTokens: 0,
    costUsd: 0,
    calls: sumBy(groups.get(r.name)!, (e) => e.callCount),
    sessions: 0,
    percentOfMax: pcts[i],
  }));
}

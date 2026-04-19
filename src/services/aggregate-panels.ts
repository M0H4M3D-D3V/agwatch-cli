import type { UsageEvent, AggregateRow, DailyRow } from '../domain/types.js';
import { groupBy, unique } from '../utils/group.js';
import { toDayKey } from '../utils/dates.js';

function computePercentOfMax(rows: { value: number }[]): number[] {
  const maxVal = Math.max(...rows.map((r) => r.value), 0);
  return rows.map((r) => (maxVal > 0 ? (r.value / maxVal) * 100 : 0));
}

export function aggregateByDay(events: UsageEvent[]): DailyRow[] {
  const groups = groupBy(events, (e) => toDayKey(e.ts));
  const rows: { name: string; day: string; value: number; inputTokens: number; outputTokens: number; costUsd: number; calls: number; sessions: string[] }[] = [];

  for (const [day, items] of groups) {
    rows.push({
      name: day,
      day,
      value: items.reduce((s, e) => s + e.costUsd, 0),
      inputTokens: items.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: items.reduce((s, e) => s + e.outputTokens, 0),
      costUsd: items.reduce((s, e) => s + e.costUsd, 0),
      calls: items.reduce((s, e) => s + e.callCount, 0),
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
      value: items.reduce((s, e) => s + e.costUsd, 0),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => {
    const items = groups.get(r.name) ?? [];
    return {
      name: r.name,
      inputTokens: items.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: items.reduce((s, e) => s + e.outputTokens, 0),
      costUsd: items.reduce((s, e) => s + e.costUsd, 0),
      calls: items.reduce((s, e) => s + e.callCount, 0),
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
      value: items.reduce((s, e) => s + e.costUsd, 0),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => {
    const items = groups.get(r.name) ?? [];
    return {
      name: r.name,
      inputTokens: items.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: items.reduce((s, e) => s + e.outputTokens, 0),
      costUsd: items.reduce((s, e) => s + e.costUsd, 0),
      calls: items.reduce((s, e) => s + e.callCount, 0),
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
      value: items.reduce((s, e) => s + e.costUsd, 0),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => {
    const items = groups.get(r.name) ?? [];
    return {
      name: r.name,
      inputTokens: items.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: items.reduce((s, e) => s + e.outputTokens, 0),
      costUsd: items.reduce((s, e) => s + e.costUsd, 0),
      calls: items.reduce((s, e) => s + e.callCount, 0),
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
      value: items.reduce((s, e) => s + e.callCount, 0),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    calls: groups.get(r.name)!.reduce((s, e) => s + e.callCount, 0),
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
      value: items.reduce((s, e) => s + e.callCount, 0),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    calls: groups.get(r.name)!.reduce((s, e) => s + e.callCount, 0),
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
      value: items.reduce((s, e) => s + e.callCount, 0),
    });
  }

  rows.sort((a, b) => b.value - a.value);
  const pcts = computePercentOfMax(rows);

  return rows.map((r, i) => ({
    name: r.name,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    calls: groups.get(r.name)!.reduce((s, e) => s + e.callCount, 0),
    sessions: 0,
    percentOfMax: pcts[i],
  }));
}

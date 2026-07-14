import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyActivity } from '../dist/domain/activity-classifier.js';
import {
  aggregateByDay,
  aggregateByMcpServer,
  aggregateByProject,
  aggregateByShellCommand,
  aggregateByTool,
} from '../dist/services/aggregate-panels.js';
import { aggregateSummary } from '../dist/services/aggregate-summary.js';

function event(overrides = {}) {
  return {
    agentId: 'opencode',
    ts: '2026-07-14T12:00:00.000Z',
    sessionId: 'session-1',
    project: 'agwatch',
    activity: 'General',
    provider: 'openai',
    model: 'openai/gpt-test',
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    writtenTokens: 0,
    costUsd: 1,
    callCount: 1,
    ...overrides,
  };
}

test('sessions are unique by agent and raw session id', () => {
  const events = [event(), event({ agentId: 'claude' })];
  assert.equal(aggregateSummary(events).totalSessions, 2);
  assert.equal(aggregateByDay(events)[0].sessions, 2);
  assert.equal(aggregateByProject(events)[0].sessions, 2);

  assert.equal(aggregateSummary([event(), event()]).totalSessions, 1);
});

test('tool aggregation counts each invocation without duplicating usage events', () => {
  const events = [
    event({ toolNames: ['Read', 'Read', 'Write'], toolName: 'Read' }),
    event({ toolName: 'Grep', callCount: 3 }),
  ];
  const rows = aggregateByTool(events);
  assert.equal(rows.find((row) => row.name === 'Read')?.calls, 2);
  assert.equal(rows.find((row) => row.name === 'Write')?.calls, 1);
  assert.equal(rows.find((row) => row.name === 'Grep')?.calls, 3);
  assert.equal(rows.some((row) => row.name.includes(',')), false);
  assert.equal(aggregateSummary(events).totalCalls, 4);
});

test('activity classification considers every tool in an event', () => {
  assert.equal(classifyActivity(event({ toolNames: ['Read', 'Grep'], toolName: 'Read' })), 'Exploration');
});

test('shell and MCP panels count every invocation with scalar compatibility', () => {
  const events = [
    event({ shellCommands: ['npm', 'npm', 'git'], shellCommand: 'npm', mcpServers: ['one', 'two'], mcpServer: 'one' }),
    event({ shellCommand: 'node', mcpServer: 'legacy', callCount: 2 }),
  ];
  const commands = aggregateByShellCommand(events);
  const servers = aggregateByMcpServer(events);
  assert.equal(commands.find((row) => row.name === 'npm')?.calls, 2);
  assert.equal(commands.find((row) => row.name === 'git')?.calls, 1);
  assert.equal(commands.find((row) => row.name === 'node')?.calls, 2);
  assert.equal(servers.find((row) => row.name === 'one')?.calls, 1);
  assert.equal(servers.find((row) => row.name === 'two')?.calls, 1);
  assert.equal(servers.find((row) => row.name === 'legacy')?.calls, 2);
});

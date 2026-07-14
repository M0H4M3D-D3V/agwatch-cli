import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { ClaudeAdapter } from '../dist/adapters/claude/index.js';
import { resolveClaudePaths } from '../dist/adapters/claude/paths.js';
import { OpenCodeAdapter } from '../dist/adapters/opencode/index.js';

const range = {
  from: new Date('2026-07-14T00:00:00.000Z'),
  to: new Date('2026-07-14T23:59:59.999Z'),
  label: 'fixture',
};

test('OpenCode JSON configuration filters by message time and keeps source identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agwatch-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['sessions', 'messages', 'parts']) fs.mkdirSync(path.join(root, dir));

  fs.writeFileSync(path.join(root, 'sessions', 'session.json'), JSON.stringify({
    id: 'session-1', created_at: '2026-01-01T00:00:00.000Z', project: '/work/agwatch',
  }));
  fs.writeFileSync(path.join(root, 'messages', 'message.json'), JSON.stringify({
    id: 'message-1', session_id: 'session-1', role: 'assistant', model: 'gpt-5', provider: 'openai',
    input_tokens: 10, output_tokens: 5, created_at: '2026-07-14T12:00:00.000Z',
  }));
  fs.writeFileSync(path.join(root, 'parts', 'part.json'), JSON.stringify({
    id: 'part-1', message_id: 'message-1', type: 'tool-call', name: 'read',
  }));
  fs.writeFileSync(path.join(root, 'parts', 'bash-1.json'), JSON.stringify({
    id: 'part-2', message_id: 'message-1', type: 'tool-call', name: 'bash', text: 'npm test',
  }));
  fs.writeFileSync(path.join(root, 'parts', 'bash-2.json'), JSON.stringify({
    id: 'part-3', message_id: 'message-1', type: 'tool-call', name: 'bash', text: 'git status',
  }));
  fs.writeFileSync(path.join(root, 'parts', 'mcp-1.json'), JSON.stringify({
    id: 'part-4', message_id: 'message-1', type: 'tool-call', name: 'mcp__one__read',
  }));
  fs.writeFileSync(path.join(root, 'parts', 'mcp-2.json'), JSON.stringify({
    id: 'part-5', message_id: 'message-1', type: 'tool-call', name: 'mcp__two__read',
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline fixture'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const adapter = new OpenCodeAdapter({ id: 'custom-open', label: 'Custom', enabled: true, type: 'json', paths: [root] });
  const events = await adapter.loadEvents(range);
  assert.equal(adapter.getSource(), 'json');
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, 'custom-open');
  assert.deepEqual(events[0].toolNames?.toSorted(), ['Bash', 'Bash', 'Read', 'mcp__one__read', 'mcp__two__read']);
  assert.deepEqual(events[0].shellCommands, ['npm', 'git']);
  assert.deepEqual(events[0].mcpServers, ['one', 'two']);

  const missingCustom = new OpenCodeAdapter({
    id: 'missing-open', label: 'Missing', enabled: true, source: 'opencode', type: 'sqlite', paths: [path.join(root, 'missing.db')],
  });
  assert.deepEqual(await missingCustom.loadEvents(range), []);
  assert.equal(missingCustom.getSource(), 'none');
});

test('Claude resolves configured files, project directories, and roots without duplicates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agwatch-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project-a');
  fs.mkdirSync(project);
  const file = path.join(project, 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    type: 'assistant', timestamp: '2026-07-14T12:00:00.000Z', sessionId: 'claude-1', cwd: '/work/agwatch',
    message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
  }));

  const config = { id: 'claude-custom', label: 'Claude', enabled: true, source: 'claude', type: 'jsonl', paths: [root, project, file] };
  assert.deepEqual(resolveClaudePaths(config), [path.resolve(file)]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline fixture'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const events = await new ClaudeAdapter(config).loadEvents(range);
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, 'claude-custom');
});

test('custom JSONL IDs dispatch through their configured source', (t) => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'agwatch-config-'));
  t.after(() => fs.rmSync(xdg, { recursive: true, force: true }));
  const project = path.join(xdg, 'fixture-project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'session.jsonl'), JSON.stringify({
    type: 'assistant', timestamp: '2026-07-14T12:00:00.000Z', sessionId: 'custom-1', cwd: '/work/agwatch',
    message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
  }));

  const configDir = path.join(xdg, 'agwatch');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    agents: [
      { id: 'opencode', label: 'OpenCode', enabled: false, source: 'opencode', type: 'sqlite', paths: [] },
      { id: 'claude', label: 'Claude', enabled: false, source: 'claude', type: 'jsonl', paths: [] },
      { id: 'codex', label: 'Codex', enabled: false, source: 'codex', type: 'jsonl', paths: [] },
      { id: 'work-claude', label: 'Work Claude', enabled: true, source: 'claude', type: 'jsonl', paths: [project] },
    ],
    providers: [],
    dashboard: { resizeMode: 'responsive' },
  }));
  fs.writeFileSync(path.join(configDir, 'pricing-cache.json'), JSON.stringify({
    schemaVersion: 2,
    ts: Date.now(),
    pricing: { 'anthropic/claude-sonnet-4': { input: 0.000001, output: 0.000001, cachedInput: 0, cachedWrite: 0 } },
  }));

  const moduleUrl = new URL('../dist/services/load-usage-events.js', import.meta.url).href;
  const script = `import { loadUsageEvents } from ${JSON.stringify(moduleUrl)}; const events = await loadUsageEvents({ from: new Date('2026-07-14T00:00:00.000Z'), to: new Date('2026-07-14T23:59:59.999Z'), label: 'fixture' }); process.stdout.write(JSON.stringify(events.map(e => e.agentId)));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['work-claude']);

  const savedConfig = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  savedConfig.agents.find((agent) => agent.id === 'work-claude').enabled = false;
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(savedConfig));
  const disabledResult = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  });
  assert.equal(disabledResult.status, 0, disabledResult.stderr);
  assert.deepEqual(JSON.parse(disabledResult.stdout), []);
});

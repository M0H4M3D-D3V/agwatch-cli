import type { TimeRangeFilter, UsageEvent } from '../domain/types.js';
import { OpenCodeAdapter } from '../adapters/opencode/index.js';
import { ClaudeAdapter } from '../adapters/claude/index.js';
import { CodexAdapter } from '../adapters/codex/index.js';
import { normalize } from '../domain/normalize.js';
import { getEnabledAgents, getAgentById } from '../config/agents.js';
import type { AgentConfig } from '../config/agents.js';

export async function loadUsageEvents(range: TimeRangeFilter, agentId?: string): Promise<UsageEvent[]> {
  const agents = agentId
    ? [getAgentById(agentId)].filter((agent): agent is AgentConfig => !!agent?.enabled)
    : getEnabledAgents();

  if (agents.length === 0) return [];

  const allEvents: UsageEvent[] = [];

  for (const agent of agents) {
    const source = agent.source ?? agent.id;
    if (agent.type === 'sqlite' || agent.type === 'json') {
      const adapter = new OpenCodeAdapter(agent);
      const raw = await adapter.loadEvents(range);
      const events = normalize(raw);
      allEvents.push(...events);
    } else if (agent.type === 'jsonl' && source === 'claude') {
      const adapter = new ClaudeAdapter(agent);
      const raw = await adapter.loadEvents(range);
      const events = normalize(raw);
      allEvents.push(...events);
    } else if (agent.type === 'jsonl' && source === 'codex') {
      const adapter = new CodexAdapter(agent);
      const raw = await adapter.loadEvents(range);
      const events = normalize(raw);
      allEvents.push(...events);
    }
  }

  return allEvents;
}

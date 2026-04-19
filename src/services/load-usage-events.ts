import type { TimeRangeFilter, UsageEvent } from '../domain/types.js';
import { OpenCodeAdapter } from '../adapters/opencode/index.js';
import { ClaudeAdapter } from '../adapters/claude/index.js';
import { normalize } from '../domain/normalize.js';
import { getEnabledAgents, getAgentById } from '../config/agents.js';
import type { AgentConfig } from '../config/agents.js';

export async function loadUsageEvents(range: TimeRangeFilter, agentId?: string): Promise<UsageEvent[]> {
  const agents = agentId
    ? [getAgentById(agentId)].filter(Boolean) as AgentConfig[]
    : getEnabledAgents();

  if (agents.length === 0) {
    const adapter = new OpenCodeAdapter();
    const raw = await adapter.loadEvents(range);
    return normalize(raw);
  }

  const allEvents: UsageEvent[] = [];

  for (const agent of agents) {
    if (agent.type === 'sqlite' || agent.type === 'json') {
      const adapter = new OpenCodeAdapter(agent);
      const raw = await adapter.loadEvents(range);
      const events = normalize(raw);
      allEvents.push(...events);
    } else if (agent.type === 'jsonl') {
      const adapter = new ClaudeAdapter();
      const raw = await adapter.loadEvents(range);
      const events = normalize(raw);
      allEvents.push(...events);
    }
  }

  return allEvents;
}

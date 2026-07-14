import type { TimeRangeFilter, UsageEvent } from '../../domain/types.js';
import type { AgentConfig } from '../../config/agents.js';
import { initPricing } from '../opencode/mapper.js';
import { resolveCodexPaths } from './paths.js';
import { parseCodexJsonlFile } from './reader.js';
import { mapCodexEntries } from './mapper.js';

export class CodexAdapter {
  constructor(private readonly agentConfig?: AgentConfig) {}

  async loadEvents(range: TimeRangeFilter): Promise<UsageEvent[]> {
    await initPricing();

    const files = resolveCodexPaths(this.agentConfig);
    if (files.length === 0) return [];

    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const allEntries = [];

    for (const file of files) {
      const entries = await parseCodexJsonlFile(file, fromMs, toMs);
      allEntries.push(...entries);
    }

    return mapCodexEntries(allEntries, this.agentConfig?.id);
  }
}

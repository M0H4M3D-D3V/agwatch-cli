import type { TimeRangeFilter, UsageEvent } from '../../domain/types.js';
import { resolveClaudePaths } from './paths.js';
import { parseJsonlFile } from './reader.js';
import { mapClaudeEntries } from './mapper.js';
import { initPricing } from '../opencode/mapper.js';

export class ClaudeAdapter {
  async loadEvents(range: TimeRangeFilter): Promise<UsageEvent[]> {
    await initPricing();

    const files = resolveClaudePaths();
    if (files.length === 0) return [];

    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();

    const allEntries = [];
    for (const file of files) {
      const entries = await parseJsonlFile(file, fromMs, toMs);
      allEntries.push(...entries);
    }

    return mapClaudeEntries(allEntries);
  }
}

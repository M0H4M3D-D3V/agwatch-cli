import type { TimeRangeFilter, UsageEvent } from '../../domain/types.js';
import { SqliteReaderFallback } from './sqlite-reader-fallback.js';
import { JsonReader } from './json-reader.js';
import { mapToUsageEvents, initPricing } from './mapper.js';
import type { AgentConfig } from '../../config/agents.js';
import { resolveAgentPaths } from '../../config/agents.js';
import { findOpenCodeDbPath } from './paths.js';

export class OpenCodeAdapter {
  private source: 'sqlite' | 'json' | null = null;
  private paths: string[] = [];

  constructor(private readonly agentConfig?: AgentConfig) {
    if (agentConfig) {
      this.paths = resolveAgentPaths(agentConfig);
    } else {
      const dbPath = findOpenCodeDbPath();
      if (dbPath) this.paths = [dbPath];
    }
  }

  async loadEvents(range: TimeRangeFilter): Promise<UsageEvent[]> {
    this.source = null;
    await initPricing();

    if (this.agentConfig?.type === 'json') {
      for (const dataPath of this.paths) {
        const result = this.tryJson(dataPath, range);
        if (result) return result;
      }
      return [];
    }

    for (const dbPath of this.paths) {
      try {
        const result = await this.tryFallbackSqlite(dbPath, range);
        if (result) return result;
      } catch {
        // continue to next dbPath
      }
    }

    if (!this.agentConfig || this.agentConfig.id === 'opencode') {
      const jsonResult = this.tryJson(undefined, range);
      if (jsonResult) return jsonResult;
    }

    return [];
  }

  private async tryFallbackSqlite(dbPath: string, range: TimeRangeFilter): Promise<UsageEvent[] | null> {
    const fallbackReader = new SqliteReaderFallback();
    const ok = await fallbackReader.open(dbPath);
    if (!ok) return null;
    this.source = 'sqlite';
    try {
      const sessions = fallbackReader.getSessions();
      const sessionIds = sessions.map((s) => s.id);
      const messages = fallbackReader.getMessages(sessionIds, range);
      const messageIds = messages.map((m) => m.id);
      const parts = fallbackReader.getParts(messageIds);
      return mapToUsageEvents(sessions, messages, parts, this.agentConfig?.id);
    } finally {
      fallbackReader.close();
    }
  }

  private tryJson(dataPath: string | undefined, range: TimeRangeFilter): UsageEvent[] | null {
    const reader = new JsonReader();
    if (!reader.open(dataPath)) return null;
    this.source = 'json';
    const sessions = reader.getSessions();
    const sessionIds = sessions.map((session) => session.id);
    const messages = reader.getMessages(sessionIds, range);
    const messageIds = messages.map((message) => message.id);
    const parts = reader.getParts(messageIds);
    return mapToUsageEvents(sessions, messages, parts, this.agentConfig?.id);
  }

  getSource(): string {
    return this.source ?? 'none';
  }
}

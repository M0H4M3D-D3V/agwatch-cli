export type TimeRange = 'today' | '7d' | '30d' | 'month';

export type TimeRangeFilter = {
  from: Date;
  to: Date;
  label: string;
};

export type UsageEvent = {
  ts: string;
  sessionId: string;
  project: string;
  activity: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  writtenTokens: number;
  costUsd: number;
  callCount: number;
  toolName?: string;
  shellCommand?: string;
  mcpServer?: string;
};

export type AggregateRow = {
  name: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
  sessions: number;
  percentOfMax: number;
};

export type DailyRow = AggregateRow & {
  day: string;
};

export type SummaryMetrics = {
  totalCost: number;
  totalCalls: number;
  totalSessions: number;
  cacheHitRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  writtenTokens: number;
};

export type DashboardData = {
  summary: SummaryMetrics;
  dailyActivity: DailyRow[];
  byProject: AggregateRow[];
  byActivity: AggregateRow[];
  byModel: AggregateRow[];
  tools: AggregateRow[];
  shellCommands: AggregateRow[];
  mcpServers: AggregateRow[];
};

export type SummaryJsonOutput = {
  metadata: {
    agent: string;
    range: string;
    from?: string;
    to?: string;
    generatedAt: string;
  };
  summary: SummaryMetrics;
  panels: {
    dailyActivity: DailyRow[];
    byProject: AggregateRow[];
    byActivity: AggregateRow[];
    byModel: AggregateRow[];
    tools: AggregateRow[];
    shellCommands: AggregateRow[];
    mcpServers: AggregateRow[];
  };
};

export type ProviderUsageLimit = {
  provider: string;
  sessionUsedPct: number;
  weeklyUsedPct: number;
  sessionResetInText: string;
  weeklyResetInText: string;
};

export type AgentDefinition = {
  id: string;
  label: string;
  implemented: boolean;
};

export type DashboardState = {
  agentTab: string;
  rangeTab: TimeRange;
  watchEnabled: boolean;
  lastRefreshed: Date;
};

export interface UsageSourceAdapter {
  getSessions(range: TimeRangeFilter): Promise<RawSession[]>;
  getMessages(sessionIds: string[]): Promise<RawMessage[]>;
  getParts?(messageIds: string[]): Promise<RawPart[]>;
}

export type RawSession = {
  id: string;
  createdAt: string;
  project?: string;
  metadata?: Record<string, unknown>;
};

export type RawMessage = {
  id: string;
  sessionId: string;
  role: string;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  writtenTokens: number;
  costUsd: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type RawPart = {
  id: string;
  messageId: string;
  type: string;
  name?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

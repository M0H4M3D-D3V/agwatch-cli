import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { getConfigDir, getConfigFile } from '../utils/paths.js';

export type AgentConfig = {
  id: string;
  label: string;
  enabled: boolean;
  source?: 'opencode' | 'claude' | 'codex';
  type: 'sqlite' | 'json' | 'jsonl';
  paths: string[];
};

export type UserProviderConfig = {
  id: string;
  label: string;
  enabled: boolean;
};

export type DashboardResizeMode = 'auto' | 'responsive';

export type DashboardConfig = {
  resizeMode: DashboardResizeMode;
};

export type OpusageConfig = {
  agents: AgentConfig[];
  providers: UserProviderConfig[];
  dashboard: DashboardConfig;
};

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = getConfigFile();

const agentSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean(),
  source: z.enum(['opencode', 'claude', 'codex']).optional(),
  type: z.enum(['sqlite', 'json', 'jsonl']),
  paths: z.array(z.string()),
}).superRefine((agent, ctx) => {
  const source = agent.source ?? (agent.type === 'jsonl' ? agent.id : 'opencode');
  if (agent.type === 'jsonl' && source !== 'claude' && source !== 'codex') {
    ctx.addIssue({ code: 'custom', message: 'JSONL agents require source "claude" or "codex"', path: ['source'] });
  }
  if (agent.type !== 'jsonl' && source !== 'opencode') {
    ctx.addIssue({ code: 'custom', message: 'SQLite and JSON agents require source "opencode"', path: ['source'] });
  }
});

const providerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean(),
});

const configSchema = z.object({
  agents: z.array(agentSchema).optional().default([]),
  providers: z.array(providerSchema).optional().default([]),
  dashboard: z.object({ resizeMode: z.unknown().optional() }).optional(),
});

export function getDefaultConfig(): OpusageConfig {
  return {
    agents: [
      {
        id: 'opencode',
        label: 'OpenCode',
        enabled: true,
        source: 'opencode',
        type: 'sqlite',
        paths: [
          '~/.local/share/opencode/opencode.db',
          '~/.opencode/opencode.db',
          '~/.config/opencode/opencode.db',
        ],
      },
      {
        id: 'claude',
        label: 'Claude Code',
        enabled: true,
        source: 'claude',
        type: 'jsonl',
        paths: [
          '~/.claude/projects',
        ],
      },
      {
        id: 'codex',
        label: 'Codex',
        enabled: true,
        source: 'codex',
        type: 'jsonl',
        paths: [
          '~/.codex/sessions',
        ],
      },
    ],
    providers: [],
    dashboard: {
      resizeMode: 'auto',
    },
  };
}

function normalizeDashboardConfig(value: { resizeMode?: unknown } | undefined): DashboardConfig {
  return {
    resizeMode: value?.resizeMode === 'responsive' ? 'responsive' : 'auto',
  };
}

function expandPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveAgentPaths(agent: AgentConfig): string[] {
  return agent.paths.map(expandPath).filter((p) => fs.existsSync(p));
}

export function loadConfig(): OpusageConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      const defaultConfig = getDefaultConfig();
      saveConfig(defaultConfig);
      return defaultConfig;
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      process.stderr.write(`Warning: Invalid agwatch config; using defaults: ${z.prettifyError(parsed.error)}\n`);
      return getDefaultConfig();
    }
    const config: OpusageConfig = {
      agents: parsed.data.agents,
      providers: parsed.data.providers,
      dashboard: normalizeDashboardConfig(parsed.data.dashboard),
    };

    const defaults = getDefaultConfig();
    config.agents ??= [];
    config.providers ??= [];
    const dashboard = normalizeDashboardConfig(config.dashboard);

    const existingIds = new Set(config.agents.map(a => a.id));
    let changed = false;
    for (const def of defaults.agents) {
      if (!existingIds.has(def.id)) {
        config.agents.push(def);
        changed = true;
      }
    }
    if (!parsed.data.dashboard || config.dashboard.resizeMode !== dashboard.resizeMode) {
      config.dashboard = dashboard;
      changed = true;
    }
    if (changed) saveConfig(config);

    return config;
  } catch (err) {
    process.stderr.write(`Warning: Failed to load agwatch config; using defaults: ${err instanceof Error ? err.message : err}\n`);
    return getDefaultConfig();
  }
}

export function saveConfig(config: OpusageConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`Warning: Failed to save agwatch config: ${err instanceof Error ? err.message : err}\n`);
  }
}

export function getEnabledAgents(): AgentConfig[] {
  const config = loadConfig();
  return config.agents.filter((a) => a.enabled);
}

export function getAgentById(id: string): AgentConfig | undefined {
  const config = loadConfig();
  return config.agents.find((a) => a.id === id);
}

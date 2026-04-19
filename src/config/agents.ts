import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigDir, getConfigFile } from '../utils/paths.js';

export type AgentConfig = {
  id: string;
  label: string;
  enabled: boolean;
  type: 'sqlite' | 'json' | 'jsonl';
  paths: string[];
};

export type UserProviderConfig = {
  id: string;
  label: string;
  enabled: boolean;
};

export type OpusageConfig = {
  agents: AgentConfig[];
  providers: UserProviderConfig[];
};

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = getConfigFile();

export function getDefaultConfig(): OpusageConfig {
  return {
    agents: [
      {
        id: 'opencode',
        label: 'OpenCode',
        enabled: true,
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
        type: 'jsonl',
        paths: [
          '~/.claude/projects',
        ],
      },
    ],
    providers: [],
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
    const config = JSON.parse(raw) as OpusageConfig;

    const defaults = getDefaultConfig();
    const existingIds = new Set(config.agents.map(a => a.id));
    let changed = false;
    for (const def of defaults.agents) {
      if (!existingIds.has(def.id)) {
        config.agents.push(def);
        changed = true;
      }
    }
    if (changed) saveConfig(config);

    return config;
  } catch {
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

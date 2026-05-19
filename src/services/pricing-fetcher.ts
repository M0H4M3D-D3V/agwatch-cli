import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { getPricingCacheFile } from '../utils/paths.js';
import { nonNegativeNumber } from '../utils/numbers.js';

const PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_FILE = getPricingCacheFile();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 2;

export interface ModelPricing {
  input: number;
  output: number;
  cachedInput: number;
  cachedWrite: number;
}

type LiteLLMEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  mode?: string;
  litellm_provider?: string;
};

type LiteLLMPricing = Record<string, LiteLLMEntry>;

const MODEL_KEY_MAP: Record<string, string[]> = {
  'openai/gpt-5.5':       ['gpt-5.5'],
  'openai/gpt-5.4':       ['gpt-5.4'],
  'openai/gpt-5.3-codex': ['gpt-5.3-codex'],
  'openai/gpt-5':         ['gpt-5'],
  'openai/gpt-4.1':       ['gpt-4.1'],
  'openai/gpt-4o':        ['gpt-4o'],
  'openai/gpt-4':         ['gpt-4'],
  'openai/o3':            ['o3'],
  'openai/o3-mini':       ['o3-mini'],
  'openai/o4-mini':       ['o4-mini'],
  'openai/o4':            ['o4'],
  'anthropic/claude-opus-4':     ['claude-opus-4-1', 'claude-opus-4-0', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805'],
  'anthropic/claude-sonnet-4':   ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514'],
  'anthropic/claude-3.5-sonnet': ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'anthropic.claude-3-5-sonnet-20240620-v1:0'],
  'anthropic/claude-3.5-haiku':  ['anthropic.claude-3-5-haiku-20241022-v1:0'],
  'anthropic/claude-3-opus':     ['claude-3-opus-20240229'],
  'anthropic/claude':            ['claude-sonnet-4-5', 'claude-3-5-sonnet-20241022'],
  'google/gemini-2.5-pro':   ['gemini-2.5-pro'],
  'google/gemini-2.5-flash': ['gemini-2.5-flash'],
  'google/gemini':           ['gemini-2.5-pro'],
  'xai/grok':                ['xai/grok-4', 'xai/grok-3', 'xai/grok-2'],
  'glm-5.1':                 ['zai/glm-5'],
  'kimi-k2.6':            ['moonshot/kimi-k2.6'],
  'minimax-m2.5':         ['minimax.minimax-m2.5', 'openrouter/minimax/minimax-m2.5'],
  'qwen3.6-plus':         ['openrouter/qwen/qwen3.6-plus'],
};

let cachedPricing: Record<string, ModelPricing> | null = null;
let cachedTimestamp: number | null = null;

function fetchJson(url: string): Promise<LiteLLMPricing> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function normalizePricing(value: unknown): ModelPricing | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<ModelPricing>;
  const input = nonNegativeNumber(entry.input);
  const output = nonNegativeNumber(entry.output);
  if (input === 0 && output === 0) return null;
  const cachedInput = entry.cachedInput == null ? input * 0.1 : nonNegativeNumber(entry.cachedInput);
  const cachedWrite = entry.cachedWrite == null ? input * 1.25 : nonNegativeNumber(entry.cachedWrite);
  return { input, output, cachedInput, cachedWrite };
}

function pricingFromLiteLLMEntry(entry: LiteLLMEntry): ModelPricing | null {
  if (entry.input_cost_per_token == null || entry.output_cost_per_token == null) return null;
  const input = nonNegativeNumber(entry.input_cost_per_token);
  const output = nonNegativeNumber(entry.output_cost_per_token);
  if (input === 0 && output === 0) return null;
  const cachedInput = entry.cache_read_input_token_cost == null
    ? input * 0.1
    : nonNegativeNumber(entry.cache_read_input_token_cost);
  const cachedWrite = entry.cache_creation_input_token_cost == null
    ? input * 1.25
    : nonNegativeNumber(entry.cache_creation_input_token_cost);

  return { input, output, cachedInput, cachedWrite };
}

function pricingAliases(key: string): string[] {
  const aliases = new Set<string>();
  const lower = key.toLowerCase();
  aliases.add(lower);

  const slashParts = lower.split('/');
  const lastSlashPart = slashParts[slashParts.length - 1] ?? lower;
  aliases.add(lastSlashPart);

  const dotParts = lastSlashPart.split('.');
  aliases.add(dotParts[dotParts.length - 1] ?? lastSlashPart);

  for (const alias of [...aliases]) {
    if (alias.endsWith('-free')) aliases.add(alias.slice(0, -5));
  }

  return [...aliases].filter(Boolean);
}

function extractPricing(data: LiteLLMPricing): Record<string, ModelPricing> {
  const result: Record<string, ModelPricing> = {};

  for (const [key, entry] of Object.entries(data)) {
    const pricing = pricingFromLiteLLMEntry(entry);
    if (!pricing) continue;
    for (const alias of pricingAliases(key)) {
      result[alias] ??= pricing;
    }
  }

  for (const [ourModel, litellmKeys] of Object.entries(MODEL_KEY_MAP)) {
    for (const key of litellmKeys) {
      const entry = data[key];
      if (entry) {
        const pricing = pricingFromLiteLLMEntry(entry);
        if (!pricing) continue;
        result[ourModel] = pricing;
        break;
      }
    }
  }

  return result;
}

function readCache(): { pricing: Record<string, ModelPricing>; ts: number; schemaVersion?: number } | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.ts || !parsed.pricing) return null;
    const pricing: Record<string, ModelPricing> = {};
    for (const [key, value] of Object.entries(parsed.pricing as Record<string, unknown>)) {
      const normalized = normalizePricing(value);
      if (normalized) pricing[key] = normalized;
    }
    if (Object.keys(pricing).length === 0) return null;
    return { ts: Number(parsed.ts), pricing, schemaVersion: Number(parsed.schemaVersion ?? 1) };
  } catch {
    return null;
  }
}

function writeCache(pricing: Record<string, ModelPricing>): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, ts: Date.now(), pricing }, null, 2), 'utf8');
  } catch {}
}

export async function fetchPricing(force = false): Promise<Record<string, ModelPricing>> {
  if (!force && cachedPricing && cachedTimestamp) return cachedPricing;

  const cache = readCache();

  if (!force && cache && cache.schemaVersion === CACHE_SCHEMA_VERSION && Date.now() - cache.ts < CACHE_TTL_MS) {
    cachedPricing = cache.pricing;
    cachedTimestamp = cache.ts;
    return cachedPricing;
  }

  try {
    const data = await fetchJson(PRICING_URL);
    const pricing = extractPricing(data);
    writeCache(pricing);
    cachedPricing = pricing;
    cachedTimestamp = Date.now();
    return pricing;
  } catch {
    if (cache) {
      cachedPricing = cache.pricing;
      cachedTimestamp = cache.ts;
      return cache.pricing;
    }
    return {};
  }
}

export async function refreshPricing(): Promise<void> {
  cachedPricing = null;
  cachedTimestamp = null;
  await fetchPricing(true);
}

export function getCachedPricing(): Record<string, ModelPricing> | null {
  return cachedPricing;
}

export function getPricingTimestamp(): number | null {
  if (cachedTimestamp) return cachedTimestamp;
  const cache = readCache();
  return cache?.ts ?? null;
}

export function formatPricingDate(ts: number): string {
  const d = new Date(ts);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd} ${month} ${yyyy} · ${hh}:${mi}`;
}

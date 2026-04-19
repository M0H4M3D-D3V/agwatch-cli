import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { getPricingCacheFile } from '../utils/paths.js';

const PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_FILE = getPricingCacheFile();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelPricing {
  input: number;
  output: number;
  cachedInput: number;
}

type LiteLLMEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  mode?: string;
  litellm_provider?: string;
};

type LiteLLMPricing = Record<string, LiteLLMEntry>;

const MODEL_KEY_MAP: Record<string, string[]> = {
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
  'anthropic/claude-3.5-sonnet': ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-latest'],
  'anthropic/claude-3.5-haiku':  ['claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest'],
  'anthropic/claude-3-opus':     ['claude-3-opus-20240229'],
  'anthropic/claude':            ['claude-sonnet-4-5', 'claude-3-5-sonnet-20241022'],
  'google/gemini-2.5-pro':   ['gemini-2.5-pro'],
  'google/gemini-2.5-flash': ['gemini-2.5-flash'],
  'google/gemini':           ['gemini-2.5-pro'],
  'xai/grok':                ['xai/grok-4', 'xai/grok-3', 'xai/grok-2'],
  'glm-5.1':                 ['zai/glm-5'],
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

function extractPricing(data: LiteLLMPricing): Record<string, ModelPricing> {
  const result: Record<string, ModelPricing> = {};

  for (const [ourModel, litellmKeys] of Object.entries(MODEL_KEY_MAP)) {
    for (const key of litellmKeys) {
      const entry = data[key];
      if (entry && entry.input_cost_per_token != null && entry.output_cost_per_token != null) {
        result[ourModel] = {
          input: entry.input_cost_per_token,
          output: entry.output_cost_per_token,
          cachedInput: entry.cache_read_input_token_cost ?? entry.input_cost_per_token * 0.5,
        };
        break;
      }
    }
  }

  return result;
}

function readCache(): { pricing: Record<string, ModelPricing>; ts: number } | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.ts || !parsed.pricing) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(pricing: Record<string, ModelPricing>): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), pricing }, null, 2), 'utf8');
  } catch {}
}

export async function fetchPricing(force = false): Promise<Record<string, ModelPricing>> {
  if (!force && cachedPricing && cachedTimestamp) return cachedPricing;

  const cache = readCache();

  if (!force && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
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

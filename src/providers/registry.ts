import type { ProviderConnector } from './types.js';
import { OpenAIConnector } from './openai.js';
import { AnthropicConnector } from './anthropic.js';
import { ZAIConnector } from './zai.js';
import { OpenCodeGoConnector } from './opencodego.js';
import { SUPPORTED_PROVIDERS } from '../config/providers.js';

const connectors: Map<string, ProviderConnector> = new Map();

function getOrCreate(id: string): ProviderConnector | undefined {
  if (!SUPPORTED_PROVIDERS.find(p => p.id === id)) return undefined;
  if (!connectors.has(id)) {
    switch (id) {
      case 'openai':
        connectors.set(id, new OpenAIConnector());
        break;
      case 'anthropic':
        connectors.set(id, new AnthropicConnector());
        break;
      case 'zai':
        connectors.set(id, new ZAIConnector());
        break;
      case 'opencodego':
        connectors.set(id, new OpenCodeGoConnector());
        break;
      default:
        return undefined;
    }
  }
  return connectors.get(id)!;
}

export function getConnector(providerId: string): ProviderConnector | undefined {
  return getOrCreate(providerId);
}

export function getAllConnectors(): ProviderConnector[] {
  return SUPPORTED_PROVIDERS.map(p => getOrCreate(p.id)).filter((c): c is ProviderConnector => !!c);
}

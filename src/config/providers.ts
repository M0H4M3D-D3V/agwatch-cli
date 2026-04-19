export type SupportedProvider = {
  id: string;
  label: string;
  color: string;
  authUrl: string;
  authSuccessPattern: string;
  usageUrl: string;
};

export const SUPPORTED_PROVIDERS: SupportedProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    color: '#5BE0F5',
    authUrl: 'https://chatgpt.com/auth',
    authSuccessPattern: 'chatgpt.com/',
    usageUrl: 'https://chatgpt.com/codex/cloud/settings/usage',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    color: '#C77DFF',
    authUrl: 'https://claude.ai/login',
    authSuccessPattern: 'claude.ai/',
    usageUrl: 'https://claude.ai/settings/usage',
  },
  {
    id: 'zai',
    label: 'Z.AI',
    color: '#4A90D9',
    authUrl: 'https://chat.z.ai/auth',
    authSuccessPattern: 'z.ai/',
    usageUrl: 'https://z.ai/manage-apikey/subscription',
  },
];

export function getSupportedProvider(id: string): SupportedProvider | undefined {
  return SUPPORTED_PROVIDERS.find(p => p.id === id);
}

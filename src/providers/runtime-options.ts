export type FallbackMode = 'never' | 'on_auth_error' | 'on_any_error';

export type ProviderRuntimeOptions = {
  debug: boolean;
  startupTimeoutMs: number;
  manualTimeoutMs: number;
  fallbackMode: FallbackMode;
};

const defaults: ProviderRuntimeOptions = {
  debug: false,
  startupTimeoutMs: 25_000,
  manualTimeoutMs: 35_000,
  fallbackMode: 'on_auth_error',
};

let current: ProviderRuntimeOptions = { ...defaults };

export function getProviderRuntimeOptions(): ProviderRuntimeOptions {
  return current;
}

export function setProviderRuntimeOptions(partial: Partial<ProviderRuntimeOptions>): void {
  const next: Partial<ProviderRuntimeOptions> = {};
  if (partial.debug !== undefined) next.debug = partial.debug;
  if (partial.startupTimeoutMs !== undefined) next.startupTimeoutMs = partial.startupTimeoutMs;
  if (partial.manualTimeoutMs !== undefined) next.manualTimeoutMs = partial.manualTimeoutMs;
  if (partial.fallbackMode !== undefined) next.fallbackMode = partial.fallbackMode;

  current = {
    ...current,
    ...next,
  };
}

export function resetProviderRuntimeOptions(): void {
  current = { ...defaults };
}

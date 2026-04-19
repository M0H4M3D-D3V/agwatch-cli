import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { SUPPORTED_PROVIDERS } from '../config/providers.js';
import { loadConfig, saveConfig } from '../config/agents.js';
import { getConnector } from '../providers/registry.js';
import { isPuppeteerInstalled, installPuppeteer } from '../providers/deps.js';

type PopupState = 'menu' | 'installing' | 'authenticating' | 'confirm_delete' | 'install_prompt';

type MenuItem = {
  id: string;
  label: string;
  color: string;
  type: 'configured' | 'supported';
};

export function ProviderPopup({ onClose, onProviderChanged, onQuit, width }: {
  onClose: () => void;
  onProviderChanged: () => Promise<void> | void;
  onQuit?: () => void;
  width?: number;
}) {
  const [state, setState] = useState<PopupState>('menu');
  const [cursor, setCursor] = useState(0);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [authStatus, setAuthStatus] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<string | null>(null);
  const [spinnerIndex, setSpinnerIndex] = useState(0);

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  useEffect(() => {
    if (state !== 'authenticating' && state !== 'installing') {
      setSpinnerIndex(0);
      return;
    }
    const id = setInterval(() => {
      setSpinnerIndex((i) => (i + 1) % spinnerFrames.length);
    }, 90);
    return () => clearInterval(id);
  }, [state]);

  function getMenuItems(): MenuItem[] {
    const config = loadConfig();
    const userProviders = config.providers ?? [];
    const configuredSet = new Set(userProviders.map(p => p.id));

    const items: MenuItem[] = [];

    for (const up of userProviders) {
      const sp = SUPPORTED_PROVIDERS.find(s => s.id === up.id);
      items.push({
        id: up.id,
        label: up.label,
        color: sp?.color ?? '#999',
        type: 'configured',
      });
    }

    for (const sp of SUPPORTED_PROVIDERS) {
      if (!configuredSet.has(sp.id)) {
        items.push({
          id: sp.id,
          label: sp.label,
          color: sp.color,
          type: 'supported',
        });
      }
    }

    return items;
  }

  const items = getMenuItems();

  useInput((input, key) => {
    if (input === 'q') {
      onQuit?.();
      return;
    }

    if (state === 'menu') {
      if (key.escape || input === 'p') {
        onClose();
        return;
      }
      if (key.upArrow) {
        if (items.length === 0) return;
        setCursor(prev => (prev - 1 + items.length) % items.length);
      } else if (key.downArrow) {
        if (items.length === 0) return;
        setCursor(prev => (prev + 1) % items.length);
      } else if (input === '\r' || key.return) {
        if (items.length === 0) return;
        const item = items[cursor];
        if (item.type === 'configured') {
          setPendingDelete(item.id);
          setState('confirm_delete');
        } else {
          handleConfigure(item.id);
        }
      }
    } else if (state === 'confirm_delete') {
      if (input === 'y' || input === 'Y') {
        handleDelete(pendingDelete!);
        setState('menu');
        setPendingDelete(null);
        setCursor(0);
      } else {
        setState('menu');
        setPendingDelete(null);
      }
    } else if (state === 'install_prompt') {
      if (input === 'y' || input === 'Y' || input === '\r') {
        handleInstall();
      } else {
        setPendingInstall(null);
        setState('menu');
      }
    } else if (state === 'installing') {
      if (key.escape) {
        setState('menu');
      }
      if (input && installLog.some((l) => l.toLowerCase().includes('failed'))) {
        setState('menu');
      }
    } else if (state === 'authenticating') {
      if (key.escape) {
        setState('menu');
      }
    }
  });

  async function handleConfigure(providerId: string) {
    if (!isPuppeteerInstalled()) {
      setPendingInstall(providerId);
      setState('install_prompt');
      return;
    }
    await startAuth(providerId);
  }

  async function handleInstall() {
    setState('installing');
    setInstallLog(['Installing Puppeteer...']);

    const ok = await installPuppeteer((msg) => {
      setInstallLog(prev => [...prev.slice(-8), msg]);
    });

    if (ok) {
      setInstallLog(prev => [...prev, 'Installation complete. Starting auth...']);
      if (pendingInstall) {
        await startAuth(pendingInstall);
        setPendingInstall(null);
      } else {
        setState('menu');
      }
    } else {
      setInstallLog(prev => [...prev, 'Installation failed. Press any key to go back.']);
    }
  }

  async function startAuth(providerId: string) {
    setState('authenticating');
    setAuthStatus('Opening browser...');

    const conn = getConnector(providerId);
    if (!conn) {
      setAuthStatus('Provider not found.');
      setState('menu');
      return;
    }

    try {
      await conn.authenticate((msg) => setAuthStatus(msg));

      const config = loadConfig();
      const sp = SUPPORTED_PROVIDERS.find(s => s.id === providerId);
      if (!config.providers) config.providers = [];
      if (!config.providers.find(p => p.id === providerId)) {
        config.providers.push({
          id: providerId,
          label: sp?.label ?? providerId,
          enabled: true,
        });
        saveConfig(config);
      }

      setAuthStatus('Authenticated. Loading usage...');
      await Promise.resolve(onProviderChanged());
      setAuthStatus('Provider configured successfully!');
      setTimeout(() => {
        setState('menu');
        setCursor(0);
      }, 1500);
    } catch (err) {
      setAuthStatus(`Auth failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setTimeout(() => setState('menu'), 2000);
    }
  }

  function handleDelete(providerId: string) {
    const conn = getConnector(providerId);
    if (conn) conn.removeConfig();

    const config = loadConfig();
    config.providers = (config.providers ?? []).filter(p => p.id !== providerId);
    saveConfig(config);

    onProviderChanged();
  }

  const configuredItems = items.filter(i => i.type === 'configured');
  const supportedItems = items.filter(i => i.type === 'supported');
  const globalCursor = cursor;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#FFD700"
      paddingX={2}
      paddingY={1}
      width={width ?? 60}
    >
      <Text bold color="#FFD700">Providers</Text>
      <Box marginTop={1}>
        <Text bold color="#E8E8E8">Configured:</Text>
      </Box>
      {configuredItems.length === 0 ? (
        <Box><Text color="#666666">  (none configured yet)</Text></Box>
      ) : (
        configuredItems.map((item, i) => (
          <Box key={item.id}>
            <Text>{globalCursor === i ? <Text color="#FF8C42">{'▸ '}</Text> : '  '}</Text>
            <Text bold color={item.color}>{item.label}</Text>
            {globalCursor === i ? <Text color="#666666">  [Enter to remove]</Text> : null}
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text bold color="#E8E8E8">Supported:</Text>
      </Box>
      {supportedItems.length === 0 ? (
        <Box><Text color="#666666">  (all configured)</Text></Box>
      ) : (
        supportedItems.map((item, i) => {
          const idx = configuredItems.length + i;
          return (
            <Box key={item.id}>
              <Text>{globalCursor === idx ? <Text color="#FF8C42">{'▸ '}</Text> : '  '}</Text>
              <Text bold color={item.color}>{item.label}</Text>
              {globalCursor === idx ? <Text color="#666666">  [Enter to configure]</Text> : null}
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text color="#666666">[Esc] close   [↑↓] navigate   [Enter] select</Text>
      </Box>

      {state === 'confirm_delete' && (
        <Box marginTop={1}>
          <Text color="#F55B5B">Remove provider? [Y/n]</Text>
        </Box>
      )}

      {state === 'install_prompt' && (
        <Box marginTop={1} flexDirection="column">
          <Text color="#FFD700">Provider auth requires Puppeteer (~150MB).</Text>
          <Text color="#999999">This will install: puppeteer, puppeteer-extra, stealth plugin</Text>
          <Text color="#FF8C42">Install now? [Y/n]</Text>
        </Box>
      )}

      {state === 'installing' && (
        <Box marginTop={1} flexDirection="column">
          <Text color="#FF8C42">{spinnerFrames[spinnerIndex]} Installing dependencies...</Text>
          {installLog.slice(-6).map((line, i) => (
            <Text key={i} color="#999999">{line}</Text>
          ))}
        </Box>
      )}

      {state === 'authenticating' && (
        <Box marginTop={1}>
          <Text color="#5BE0F5">{spinnerFrames[spinnerIndex]} {authStatus}</Text>
        </Box>
      )}
    </Box>
  );
}

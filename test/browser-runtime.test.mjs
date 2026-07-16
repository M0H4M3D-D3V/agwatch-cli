import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('persistent browser runtime is discovered independently of the agwatch package tree', (t) => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'agwatch-browser-runtime-'));
  t.after(() => fs.rmSync(xdg, { recursive: true, force: true }));
  const runtime = path.join(xdg, 'agwatch', 'browser-runtime');

  const browserPath = path.join(runtime, 'browser', process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  fs.mkdirSync(path.dirname(browserPath), { recursive: true });
  fs.writeFileSync(browserPath, '');

  for (const [name, source] of [
    ['puppeteer', `module.exports = { marker: 'puppeteer', executablePath() { return process.env.AGTEST_BROWSER_PATH; } };`],
    ['puppeteer-extra', `module.exports = { marker: 'extra', use() {}, launch() {} };`],
    ['puppeteer-extra-plugin-stealth', `function plugin() {}; plugin.marker = 'stealth'; module.exports = plugin;`],
  ]) {
    const dir = path.join(runtime, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), source);
  }
  const binDir = path.join(runtime, 'node_modules', '.bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'puppeteer.cmd' : 'puppeteer'), '');

  const moduleUrl = new URL('../dist/providers/deps.js', import.meta.url).href;
  const script = `
    const deps = await import(${JSON.stringify(moduleUrl)});
    const modules = await deps.loadPuppeteerModules();
    process.stdout.write(JSON.stringify({
      installed: deps.isPuppeteerInstalled(),
      usable: await deps.isPuppeteerUsable(),
      markers: [modules.puppeteer.marker, modules.puppeteerExtra.marker, modules.StealthPlugin.marker],
      bin: deps.getPuppeteerBinPath(),
      browser: await deps.getPuppeteerBrowserPath(),
      reused: await deps.installPuppeteer(),
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: xdg, AGTEST_BROWSER_PATH: browserPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.installed, true);
  assert.equal(output.usable, true);
  assert.deepEqual(output.markers, ['puppeteer', 'extra', 'stealth']);
  assert.match(output.bin, /browser-runtime[\\/]node_modules[\\/]\.bin[\\/]puppeteer/);
  assert.equal(output.browser, browserPath);
  assert.equal(output.reused, true);
});

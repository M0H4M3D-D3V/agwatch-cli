import assert from 'node:assert/strict';
import test from 'node:test';

import { httpRequest } from '../dist/providers/http-client.js';
import { withTimeout } from '../dist/services/provider-service.js';

test('provider timeout aborts underlying work and preserves the timeout error', async () => {
  let operationSignal;
  await assert.rejects(
    withTimeout((signal) => {
      operationSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }, 20, 'provider timed out'),
    /provider timed out/,
  );
  assert.equal(operationSignal.aborted, true);
});

test('successful provider work clears its timeout without aborting', async () => {
  let operationSignal;
  const result = await withTimeout((signal) => {
    operationSignal = signal;
    return Promise.resolve('ok');
  }, 20, 'provider timed out');
  assert.equal(result, 'ok');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(operationSignal.aborted, false);
});

test('HTTP requests compose caller cancellation with request timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  let requestSignal;
  globalThis.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return new Promise((resolve, reject) => {
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const controller = new AbortController();
  const request = httpRequest({ url: 'https://example.invalid', timeoutMs: 5_000, signal: controller.signal });
  controller.abort(new Error('caller canceled'));
  await assert.rejects(request, /caller canceled/);
  assert.equal(requestSignal.aborted, true);
});

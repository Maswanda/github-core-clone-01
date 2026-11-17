// main.ts — the entry point the trial runs as `node /bot/main.ts`.
//
// Lifecycle: bind an ephemeral port on 127.0.0.1, register it with the
// environment server, then long-poll /done until the suite says the trial is
// over and exit 0. With no MAKEFUN_ENV_URL (a local run) the server just
// keeps listening and prints its port.

import { createApp } from './app.ts';
import { createStore } from './store.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  const url = `${ENV_URL}/register`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
      lastError = new Error(`register answered HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  throw lastError instanceof Error ? lastError : new Error('register failed');
}

async function waitForDone(): Promise<void> {
  const url = `${ENV_URL}/done`;
  for (;;) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        const data = (await response.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch {
      // The environment server may restart; keep polling.
    }
    await sleep(250);
  }
}

async function main(): Promise<void> {
  const store = createStore();
  const app = createApp(store);
  const port = await app.listen(0);
  if (ENV_URL === '') {
    console.log(`forge listening on 127.0.0.1:${port}`);
    await new Promise<void>(() => {
      // Dev mode: keep listening until killed.
    });
    return;
  }
  await register(port);
  await waitForDone();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`[forge] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

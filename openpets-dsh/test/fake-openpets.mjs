// Fake OpenPets desktop app: a Unix-socket JSONL server good enough to
// exercise the plugin's IPC path — discovery file, lease.acquire,
// pet.say / pet.react — while recording every request. Tests use it to
// observe send order and how many requests are in flight at once.

import net from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Start a fake OpenPets app.
 *
 * @param options.responseDelayMs - delay before each response, which widens
 *   the window in which a racing second request would overlap.
 * @returns discovery path, received requests, max observed concurrency,
 *   a reaction-only view, and a closer.
 */
export async function startFakeOpenPets(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'openpets-fake-'));
  const endpoint = join(dir, 'openpets.sock');
  const discoveryPath = join(dir, 'ipc.json');
  const received = [];
  const responseDelayMs = options.responseDelayMs ?? 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      received.push({ method: request.method, params: request.params });
      const respond = () => {
        inFlight -= 1;
        const result =
          request.method === 'lease.acquire'
            ? { leaseId: 'lease-1', expiresAt: Date.now() + 60_000, leaseActive: true }
            : { ok: true, reaction: request.params.reaction, shown: true };
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      };
      if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
      else respond();
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  writeFileSync(discoveryPath, JSON.stringify({ endpoint, token: 'test-token' }));

  return {
    discoveryPath,
    received,
    get maxInFlight() {
      return maxInFlight;
    },
    /** Reactions in arrival order, from `pet.react` and the reaction a `pet.say` carries. */
    reactions: () =>
      received
        .filter((entry) => entry.method === 'pet.react' || entry.method === 'pet.say')
        .map((entry) => entry.params.reaction),
    /** Methods in arrival order. */
    methods: () => received.map((entry) => entry.method),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

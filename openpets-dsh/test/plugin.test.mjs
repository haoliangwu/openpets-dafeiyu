// Plugin tests: every case drives the real event handlers against a fake
// OpenPets socket, so the IPC path (throttle, queue, lease) is exercised
// end to end. Run with `node --test`.
//
// Two timing rules shape these tests:
//   * decisions are queued and sent one at a time, so `emit` + a short delay
//     models one event per delivery;
//   * decisions arriving in the same tick while a send is in flight collapse
//     to the newest one (an intentional latest-wins rule: a burst of tool
//     events only needs the state it ends in).

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startFakeOpenPets } from './fake-openpets.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createCtx() {
  const handlers = new Map();
  return {
    on(event, handler) {
      handlers.set(event, handler);
    },
    logger: { info() {} },
    emit(event, ...args) {
      return handlers.get(event)?.(...args);
    },
  };
}

/** Fresh fake app + fresh throttle state + a plugin instance per test. */
async function loadPlugin(t, options = {}) {
  const fake = await startFakeOpenPets({ responseDelayMs: options.responseDelayMs });
  t.after(() => fake.close());
  process.env.OPENPETS_DISCOVERY_FILE = fake.discoveryPath;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'openpets-state-'));
  const { apply } = await import('../index.js');
  const ctx = createCtx();
  apply(ctx, options.config ?? {});
  return { fake, ctx };
}

const tool = (name, command, agentId = 'agent-a') => ({
  name,
  arguments: command === undefined ? {} : { command },
  agent: { id: agentId },
});

/** Emit one event and wait `ms` so the queued send can finish. */
async function emitAfter(ctx, ms, event, ...args) {
  ctx.emit(event, ...args);
  await delay(ms);
}

/** Emit one event and let the queued send finish before the next one. */
async function emitPaced(ctx, event, ...args) {
  await emitAfter(ctx, 30, event, ...args);
}

test('sends paced decisions in order without collapsing them', async (t) => {
  const { fake, ctx } = await loadPlugin(t, { responseDelayMs: 40 });

  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-a' }, status: 'running' });
  // Slower than the 40 ms response, so each decision is sent on its own
  // instead of collapsing into the next one.
  await emitAfter(ctx, 60, 'tools/pre-execute', tool('bash'), () => {});
  await emitAfter(ctx, 60, 'tools/pre-execute', tool('edit'), () => {});
  await emitAfter(ctx, 60, 'tools/pre-execute', tool('read'), () => {});
  await delay(200);

  assert.equal(fake.maxInFlight, 1, 'at most one request in flight');
  assert.deepEqual(fake.reactions(), ['thinking', 'running', 'editing', 'working']);
});

test('collapses decisions that arrive while a send is in flight', async (t) => {
  const { fake, ctx } = await loadPlugin(t, { responseDelayMs: 60 });

  // One synchronous burst: three decisions, one in flight, the rest collapse
  // to the newest — the pet must never be left on a stale reaction.
  ctx.emit('tools/pre-execute', tool('bash'), () => {});
  ctx.emit('agent/inbox/claimed', { agent: { id: 'agent-b' } });
  ctx.emit('tools/pre-execute', tool('edit'), () => {});
  await delay(400);

  assert.equal(fake.maxInFlight, 1);
  assert.deepEqual(fake.reactions(), ['running', 'editing']);
});

test('a non-driving session going idle cannot steal the pet', async (t) => {
  const { fake, ctx } = await loadPlugin(t);

  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-a' }, status: 'running' });
  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-b' }, status: 'running' });
  await emitPaced(ctx, 'tools/pre-execute', tool('edit', undefined, 'agent-a'), () => {});
  // agent-a is the driver, so its idle must hand the pet to still-running
  // agent-b instead of flashing "success" over agent-b's work.
  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-a' }, status: 'idle' });

  assert.deepEqual(fake.reactions(), ['thinking', 'editing', 'thinking']);

  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-b' }, status: 'idle' });
  assert.deepEqual(fake.reactions(), ['thinking', 'editing', 'thinking', 'success']);
});

test('a session that is not running cannot steal the pet', async (t) => {
  const { fake, ctx } = await loadPlugin(t);

  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-a' }, status: 'running' });
  await emitPaced(ctx, 'tools/pre-execute', tool('edit'), () => {}); // agent-a drives: editing
  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-b' }, status: 'running' });
  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-b' }, status: 'idle' }); // back to agent-a
  // A straggler event from the finished session must not pull the pet back.
  await emitPaced(ctx, 'tools/result', { ...tool('bash'), agent: { id: 'agent-b' } }, { isError: false });
  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-a' }, status: 'idle' });

  assert.deepEqual(fake.reactions(), ['thinking', 'editing', 'thinking', 'editing', 'success']);
});

test('reclaims a session that dies without an idle event', async (t) => {
  const { fake, ctx } = await loadPlugin(t);
  t.mock.timers.enable({ apis: ['Date'] });

  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-a' }, status: 'running' });
  await emitPaced(ctx, 'tools/pre-execute', tool('edit'), () => {});
  // agent-a never reports idle: its session is gone.
  t.mock.timers.tick(11 * 60_000);
  await emitPaced(ctx, 'agent/status', { agent: { id: 'agent-b' }, status: 'idle' });

  assert.deepEqual(fake.reactions(), ['thinking', 'editing', 'success']);
});

test('transitions always send, a repeated reaction is damped', async (t) => {
  const { fake, ctx } = await loadPlugin(t);

  await emitPaced(ctx, 'tools/pre-execute', tool('edit'), () => {});
  await emitPaced(ctx, 'tools/pre-execute', tool('edit'), () => {}); // same reaction, no heartbeat due yet
  await emitPaced(ctx, 'tools/pre-execute', tool('bash'), () => {}); // different reaction

  assert.deepEqual(fake.reactions(), ['editing', 'running']);
});

test('excluded reactions are never sent', async (t) => {
  const { fake, ctx } = await loadPlugin(t, { config: { excludeReactions: ['working'] } });

  await emitPaced(ctx, 'tools/pre-execute', tool('read'), () => {});
  await emitPaced(ctx, 'tools/pre-execute', tool('edit'), () => {});

  assert.deepEqual(fake.reactions(), ['editing']);
});

test('OpenPets own MCP tools are ignored', async (t) => {
  const { fake, ctx } = await loadPlugin(t);

  await emitPaced(ctx, 'tools/pre-execute', tool('mcp__demo__openpets_say'), () => {});
  await emitPaced(ctx, 'tools/pre-execute', tool('openpets_react'), () => {});

  assert.deepEqual(fake.reactions(), []);
});

test('a configured pet is leased before the first reaction', async (t) => {
  const { fake, ctx } = await loadPlugin(t, { config: { pet: 'dafeiyu' } });

  await emitPaced(ctx, 'tools/pre-execute', tool('edit'), () => {});

  assert.deepEqual(fake.methods(), ['lease.acquire', 'pet.react']);
  assert.equal(fake.received[0].params.requestedPetId, 'dafeiyu');
});

test('waterfall handlers forward next() and its result untouched', async (t) => {
  const { fake, ctx } = await loadPlugin(t);

  assert.equal(ctx.emit('tools/pre-execute', tool('edit'), () => 'NEXT'), 'NEXT');
  await delay(30);
  assert.equal(ctx.emit('approval/request', { agent: { id: 'agent-a' } }, () => 'NEXT'), 'NEXT');
  await delay(30);
  assert.equal(ctx.emit('user-questions/request', { agent: { id: 'agent-a' } }, () => 'NEXT'), 'NEXT');
  await delay(30);

  // The identical `waiting` decision from the questions waterfall is damped.
  assert.deepEqual(fake.reactions(), ['editing', 'waiting']);
});

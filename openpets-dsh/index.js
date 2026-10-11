// openpets-dsh — DSH plugin driving OpenPets desktop-pet reactions.
// Multi-session aware: see "Session arbitration" below.
//
// Port of the OpenCode OpenPets plugin (@open-pets/opencode@4.0.0, and its
// V2 port in opencode-v2/openpets-v2/) to the Cordis plugin API that DSH
// hosts run. Behavior parity with the OpenCode port unless noted.
//
// Transport: local IPC to the OpenPets desktop app — JSONL over a Unix
// socket, endpoint + token read from the discovery file
// ~/Library/Application Support/OpenPets/runtime/ipc.json (macOS). NOT MCP.
//
// DSH event mapping (contracts verified against the running host via the
// cordis inspect providers):
//   agent/inbox/claimed  (payload {agent,message,turn})   -> thinking + speech
//   agent/status         (payload {agent,status})          -> running -> thinking,
//                                                             idle -> success + speech
//   agent/assistant-stream (payload {agent,frame})         -> frame 'start' =
//                                                             model generating -> thinking
//   agent/error          (payload {agent,turn,step,error}) -> error + speech
//   tools/pre-execute    (exec, next) waterfall            -> classify tool:
//     edit/write/patch -> editing; bash/shell/terminal -> running|testing;
//     everything else -> working. OpenPets' own tools are ignored.
//   tools/result         (exec, result)                    -> tool done:
//     isError -> error, otherwise agent resumes -> thinking
//   approval/request     (req, next) waterfall              -> waiting + speech
//   user-questions/request (req, next) waterfall            -> waiting
//
// Reactions alternate during a turn: working only while a tool runs,
// thinking whenever the model generates, success when the agent goes idle.
// A reaction CHANGE is always sent (a state transition); only repeating the
// same reaction is damped by the persisted cooldown — so rapid tool loops
// cannot pin the pet in one state, the flaw the OpenCode V1 plugin had.
//
// Multiple sessions share this one plugin instance, so the pet is arbitrated
// rather than last-write-wins (see the "session arbitration" section):
//   * every Agent keeps its own running/reaction state;
//   * the Agent that most recently produced an event drives the pet;
//   * an Agent going idle hands the pet back to a still-running Agent, so a
//     finished session cannot flash "success" over another one's work;
//   * IPC sends are serialized with latest-wins collapse — at most one
//     request is in flight, and a newer decision replaces a queued older
//     one, so reactions can never land out of order.
//
// Throttling: same reaction 10s, speech 20s, permission speech 3s;
// persisted at ~/.local/state/openpets/dsh-hook-throttle.json (separate from
// the OpenCode plugin's file so the two agents can run side by side).

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';

export const name = 'openpets-dsh';

// Single source for the reaction vocabulary: Config schema and runtime filter.
const REACTIONS = [
  'idle', 'thinking', 'working', 'editing', 'running', 'testing',
  'waiting', 'waving', 'success', 'error', 'celebrating',
];
const allowedReactions = new Set(REACTIONS);

// Events that carry no Agent (a bare dispatch) still need a stable key.
const unscopedAgentId = '__unscoped__';

const defaultConnectTimeoutMs = 500;
const defaultResponseTimeoutMs = 500;

export const Config = Schema.object({
  pet: Schema.string().default('').description(
    'Optional OpenPets pet id to lease (e.g. "shiba"). Empty = whatever pet the app targets by default.',
  ),
  excludeReactions: Schema.array(Schema.union(REACTIONS)).default([]).description(
    'Reactions this profile should never send.',
  ),
  debug: Schema.boolean().default(false).description(
    'Log every decision and IPC error to the host log (OPENPETS_DEBUG=1 also works).',
  ),
  discoveryPath: Schema.string().default('').description(
    'Override the OpenPets discovery file path. Empty = platform default.',
  ),
  followSubagents: Schema.boolean().default(true).description(
    'Follow delegated child sessions: while a subagent runs the pet shows its work. ' +
      'Set false and only the delegating session drives the pet.',
  ),
  connectTimeoutMs: Schema.number().step(1).min(50).default(defaultConnectTimeoutMs),
  responseTimeoutMs: Schema.number().step(1).min(50).default(defaultResponseTimeoutMs),
});

const speechCooldownMs = 20_000;
const permissionCooldownMs = 3_000;
const reactionCooldownMs = 10_000;

// Speech pools cloned from @open-pets/agent-events@4.0.0 (hookSpeechPools).
// Their keys are also the speech throttle categories.
const hookSpeechPools = {
  thinking: ['Thinking it through', 'Let me check', 'On it', 'Working it out'],
  success: ['Done', 'That worked', 'All set', 'Nice, finished'],
  error: ['Something failed', 'Needs another look', 'Hit a snag', 'Not quite there'],
  permission: ['Approval needed'],
};
const speechCategories = new Set(Object.keys(hookSpeechPools));

const SESSION_NONCE = randomUUID();

function pickHookSpeech(category) {
  const pool = hookSpeechPools[category];
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0] ?? 'Working';
}

// Visible part of validateHookSpeech@4.0.0 (fixed safe pools; the URL
// rejection rule is approximated).
function validateHookSpeech(message) {
  if (message.length < 1 || message.length > 140) throw new Error('Hook speech length is invalid.');
  if (/\r|\n/.test(message)) throw new Error('Hook speech must be single line.');
  if (/```|\b(function|const|let|var|class|import|export)\b|[{};]/.test(message))
    throw new Error('Hook speech looks code-like.');
  if (/https?:\/\/\S+/.test(message)) throw new Error('Hook speech contains a URL.');
  return message;
}

function getDiscoveryFilePath() {
  if (process.env.OPENPETS_DISCOVERY_FILE) return process.env.OPENPETS_DISCOVERY_FILE;
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'OpenPets', 'runtime', 'ipc.json');
  if (process.platform === 'win32')
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'OpenPets', 'runtime', 'ipc.json');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'OpenPets', 'runtime', 'ipc.json');
}

function readDiscoveryFile(path = getDiscoveryFilePath()) {
  const raw = readFileSync(path, 'utf8');
  const value = JSON.parse(raw);
  if (typeof value.endpoint !== 'string' || typeof value.token !== 'string')
    throw new Error('OpenPets discovery file is invalid.');
  return { endpoint: value.endpoint, token: value.token };
}

function sendRequest(method, params, options) {
  const discovery = readDiscoveryFile(options.discoveryPath);
  const request = JSON.stringify({
    id: randomUUID(),
    version: 1,
    token: discovery.token,
    method,
    params,
  });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(discovery.endpoint);
    let buffer = '';
    let settled = false;
    const connectTimer = setTimeout(() => finish(new Error('Timed out connecting to OpenPets.')), options.connectTimeoutMs);
    const responseTimer = setTimeout(() => finish(new Error('Timed out waiting for OpenPets response.')), options.responseTimeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      clearTimeout(connectTimer);
      try {
        socket.write(`${request}\n`);
      } catch (error) {
        // A synchronous write failure (e.g. EPIPE after early close) must
        // settle the promise, never escape into the DSH host.
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let parsed;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (parsed.ok === true) finish(undefined, parsed.result);
      else finish(new Error(parsed?.error?.message ?? 'OpenPets request failed.'));
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      if (!settled) finish(new Error('OpenPets closed the IPC connection before responding.'));
    });
  });
}

function createOpenPetsClient(options) {
  const send = (method, params) =>
    sendRequest(method, params, {
      discoveryPath: options.discoveryPath,
      connectTimeoutMs: options.connectTimeoutMs ?? defaultConnectTimeoutMs,
      responseTimeoutMs: options.responseTimeoutMs ?? defaultResponseTimeoutMs,
    });
  return {
    acquireLease: (leaseOptions) =>
      send('lease.acquire', {
        requestedPetId: leaseOptions?.requestedPetId,
        clientPid: process.pid,
        sessionNonce: SESSION_NONCE,
      }),
    react: (reaction, reactOptions) =>
      send('pet.react', { reaction, ...(reactOptions?.leaseId === undefined ? {} : { leaseId: reactOptions.leaseId }) }),
    say: (message, sayOptions) =>
      send('pet.say', {
        message,
        ...(sayOptions?.reaction === undefined ? {} : { reaction: sayOptions.reaction }),
        ...(sayOptions?.leaseId === undefined ? {} : { leaseId: sayOptions.leaseId }),
      }),
  };
}

function validatePetArg(value) {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length < 1) throw new Error('Invalid OpenPets pet id.');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) throw new Error('Invalid OpenPets pet id.');
  return trimmed;
}

// Ported from shouldIgnoreOpenPetsTool@4.0.0: OpenPets' own MCP tools
// (openpets_say / openpets_react / openpets_status) must not make the pet
// react to itself.
function shouldIgnoreTool(toolName) {
  const normalized = (typeof toolName === 'string' ? toolName : '')
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_');
  return /(?:^|[_:-])openpets_(?:openpets_)?(?:status|say|react)$/.test(normalized);
}

// Tool classification ported from classifyOpenCodeToolReaction@4.0.0.
function classifyToolReaction(toolName, args) {
  const normalized = typeof toolName === 'string' ? toolName.toLowerCase() : '';
  if (/edit|write|patch|apply_patch/.test(normalized)) return 'editing';
  if (/bash|shell|terminal/.test(normalized)) return isTestLikeToolArgs(args) ? 'testing' : 'running';
  return 'working';
}

function isTestLikeToolArgs(args) {
  const command = isRecord(args) && typeof args.command === 'string' ? args.command.slice(0, 300) : '';
  return /\b(test|vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/i.test(command);
}

function getDefaultThrottlePath() {
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenPets', 'dsh-hook-throttle.json');
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateHome, 'openpets', 'dsh-hook-throttle.json');
}

function shouldSendSpeech(category) {
  const cooldown = category === 'permission' ? permissionCooldownMs : speechCooldownMs;
  return shouldSendThrottleKey(category, cooldown);
}

// Cross-process lock: the throttle state file is shared by every DSH host
// process; read-check-write is not atomic across processes (two sessions can
// read the same stale timestamp, both send, and a later write clobbers the
// other's timestamp). O_EXCL lockfile with stale theft; on lock trouble
// proceed unlocked (best effort, throttling must never break hooks).
const THROTTLE_LOCK_STALE_MS = 1_000;
const THROTTLE_LOCK_MAX_TRIES = 200; // ~1 s worst case, then unlocked.

function acquireThrottleLock(path) {
  const lockPath = `${path}.lock`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {}
  for (let attempt = 0; attempt < THROTTLE_LOCK_MAX_TRIES; attempt++) {
    try {
      return { fd: openSync(lockPath, 'wx'), lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { fd: undefined, lockPath };
      try {
        if (Date.now() - statSync(lockPath).mtimeMs < THROTTLE_LOCK_STALE_MS) {
          const spinUntil = Date.now() + 5;
          while (Date.now() < spinUntil) {} // bounded busy wait, sync context
          continue;
        }
        unlinkSync(lockPath);
      } catch {}
    }
  }
  return { fd: undefined, lockPath };
}

function releaseThrottleLock(acquired) {
  if (acquired.fd !== undefined) {
    try {
      closeSync(acquired.fd);
    } catch {}
  }
  try {
    unlinkSync(acquired.lockPath);
  } catch {}
}

function shouldSendThrottleKey(key, cooldown) {
  const path = getDefaultThrottlePath();
  const acquired = acquireThrottleLock(path);
  try {
    const state = readThrottleState(path);
    const previous = typeof state[key] === 'number' ? state[key] : 0;
    if (Date.now() - previous < cooldown) return false;
    state[key] = Date.now();
    writeThrottleState(path, state);
    return true;
  } finally {
    releaseThrottleLock(acquired);
  }
}

function markThrottleKey(key) {
  const path = getDefaultThrottlePath();
  const acquired = acquireThrottleLock(path);
  try {
    const state = readThrottleState(path);
    state[key] = Date.now();
    writeThrottleState(path, state);
  } finally {
    releaseThrottleLock(acquired);
  }
}

function readThrottleState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return {};
    const state = {};
    for (const [key, value] of Object.entries(parsed)) {
      if ((speechCategories.has(key) || key.startsWith('reaction:')) && typeof value === 'number' && Number.isFinite(value))
        state[key] = value;
    }
    return state;
  } catch {
    return {};
  }
}

function writeThrottleState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, path);
  } catch {
    // Best effort only; throttling must never break hooks.
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function sanitizeDebugError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, '<path>')
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .slice(0, 200);
}

function agentIdOf(payload) {
  const id = payload?.agent?.id;
  return typeof id === 'string' ? id : unscopedAgentId;
}

export function apply(ctx, config) {
  const debug = config?.debug === true || process.env.OPENPETS_DEBUG === '1';
  let logger;
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger;
  } catch {
    logger = console;
  }
  function debugLog(message) {
    if (!debug) return;
    try {
      logger.info?.(message);
    } catch {
      // Logging must never break hooks.
    }
  }

  const pet = config?.pet ? validatePetArg(config.pet) : undefined;
  const excludedReactions = new Set(
    (Array.isArray(config?.excludeReactions) ? config.excludeReactions : []).filter((reaction) =>
      allowedReactions.has(reaction),
    ),
  );

  let client;
  let lease;

  async function getLeaseId() {
    if (lease && (!lease.expiresAt || lease.expiresAt - Date.now() > 2_000)) return lease.leaseId;
    try {
      const next = await client.acquireLease({ requestedPetId: pet });
      lease = { leaseId: next.leaseId, expiresAt: next.expiresAt };
      return next.leaseId;
    } catch (error) {
      debugLog(`OpenPets lease unavailable: ${sanitizeDebugError(error)}`);
      return undefined;
    }
  }

  // ---- Send queue: serialized, latest-wins ------------------------------
  // Every DSH Session shares this instance, so sends must not race: one
  // request is in flight at a time, and a decision that arrives while an
  // older one is still queued replaces it (the pet only needs the newest
  // state, never the stale one that a second socket would deliver late).
  let pending;
  let draining = false;

  function enqueue(decision) {
    pending = decision;
    // Start immediately when idle: the first decision of a burst reaches the
    // pet right away, and the rest collapse onto it while it is in flight.
    void drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending) {
        const decision = pending;
        pending = undefined;
        await send(decision);
      }
    } finally {
      draining = false;
    }
  }

  // The reaction this host last sent — the pet's current state, as we know it.
  let shownReaction;

  function shouldSendReaction(reaction) {
    // A reaction change is a state transition: always send it. Only repeating
    // the same reaction is damped by the persisted cooldown (which doubles as
    // the keep-alive heartbeat), so rapid tool loops cannot pin the pet.
    if (reaction !== shownReaction) {
      shownReaction = reaction;
      markThrottleKey(`reaction:${reaction}`);
      return true;
    }
    return shouldSendThrottleKey(`reaction:${reaction}`, reactionCooldownMs);
  }

  async function send(decision) {
    const { reaction, speechCategory } = decision;
    if (excludedReactions.has(reaction)) return;
    try {
      const speak = speechCategory ? shouldSendSpeech(speechCategory) : false;
      const react = shouldSendReaction(reaction);
      if (!speak && !react) return;
      client ??= createOpenPetsClient({
        discoveryPath: config?.discoveryPath || undefined,
        connectTimeoutMs: config?.connectTimeoutMs,
        responseTimeoutMs: config?.responseTimeoutMs,
      });
      const leaseId = pet ? await getLeaseId() : undefined;
      if (speak) {
        await client.say(validateHookSpeech(pickHookSpeech(speechCategory)), { reaction, leaseId });
        return;
      }
      await client.react(reaction, { leaseId });
    } catch (error) {
      debugLog(`OpenPets plugin ignored error: ${sanitizeDebugError(error)}`);
    }
  }

  // ---- Session arbitration ----------------------------------------------
  // One Agent at a time drives the pet: whoever produced the most recent
  // event. State is per Agent, so concurrent sessions cannot stomp each
  // other. An entry lives while its Agent runs and is dropped when that Agent
  // goes idle.
  const agents = new Map();
  let driverId;

  // Child SessionIds currently delegating. Needed to recognise a subagent's
  // own Agent events when `followSubagents` is off.
  const children = new Set();
  const followSubagents = config?.followSubagents !== false;

  // A Session that dies without an idle event leaves its entry — and the
  // driver seat — behind. After this long without any event it is reclaimed,
  // so the next idle still settles the pet instead of leaving it stuck on a
  // reaction nobody will ever update.
  const staleAgentMs = 10 * 60_000;

  function sweepStaleAgents() {
    if (agents.size === 0) return;
    const cutoff = Date.now() - staleAgentMs;
    for (const [id, state] of agents) {
      if (state.lastEventAt > cutoff) continue;
      agents.delete(id);
      if (driverId === id) driverId = undefined;
    }
  }

  function isAnotherAgentRunning(agentId) {
    for (const [id, state] of agents) {
      if (id !== agentId && state.running) return true;
    }
    return false;
  }

  function agentState(agentId) {
    let state = agents.get(agentId);
    if (!state) {
      // A brand-new entry is fresh by definition: it must not be swept as
      // stale before its first event is even recorded.
      state = { running: false, reaction: undefined, lastEventAt: Date.now() };
      agents.set(agentId, state);
    }
    return state;
  }

  function newestRunningAgent(excludeId) {
    let best;
    for (const [id, state] of agents) {
      if (id === excludeId || !state.running) continue;
      if (!best || state.lastEventAt > best.lastEventAt) best = { id, reaction: state.reaction };
    }
    return best;
  }

  // Any session we have heard from and not seen go idle. The unscoped bucket
  // is host-level noise, never a place for the pet to settle.
  function newestKnownAgent(excludeId) {
    let best;
    for (const [id, state] of agents) {
      if (id === excludeId || id === unscopedAgentId) continue;
      if (!best || state.lastEventAt > best.lastEventAt) best = { id, reaction: state.reaction };
    }
    return best;
  }

  // Where the pet goes when its driver stops: a session still running, else
  // any session we have heard from without an idle event — a reload mid-turn
  // leaves the `running` flag unknown, and flashing "success" over that
  // session's work would be wrong.
  function handoffTarget(agentId) {
    return newestRunningAgent(agentId) ?? newestKnownAgent(agentId);
  }

  function logDecision(agentId, reaction, speechCategory) {
    debugLog(`OPENPETS_DECISION agent=${agentId} reaction=${reaction} speech=${speechCategory ?? ''}`);
  }

  // This Agent produced the most recent event: it drives the pet, and its
  // reaction becomes the pet's state. A session that is not running must not
  // pull the pet away from one that is still working — except the unscoped
  // bucket, which is how host-level and interrupt events arrive
  // (approval/request carries its Agent on the listener's `this`, not in the
  // payload, so it lands here and must still be able to show "waiting").
  function claimDriver(agentId, reaction, speechCategory) {
    sweepStaleAgents();
    if (!followSubagents && children.has(agentId)) return;
    const running = agents.get(agentId)?.running === true || agentId === unscopedAgentId;
    // A straggler from a session that is not running is ignored outright: it
    // must neither drive the pet nor leave an entry that a later hand-off
    // would mistake for a session that is still busy.
    if (!running && isAnotherAgentRunning(agentId)) return;
    const state = agentState(agentId);
    state.lastEventAt = Date.now();
    state.reaction = reaction;
    driverId = agentId;
    logDecision(agentId, reaction, speechCategory);
    enqueue({ reaction, speechCategory });
  }

  // A session stops driving: it goes idle, or (for a delegation) its child
  // settles. The pet then moves to whatever is still busy rather than flashing
  // "success" over another session's work.
  function releaseDriver(agentId) {
    sweepStaleAgents();
    const state = agentState(agentId);
    state.running = false;
    state.reaction = undefined;
    state.lastEventAt = Date.now();
    // Session that was not driving: it must not steal the pet by going idle.
    if (driverId !== undefined && driverId !== agentId) {
      agents.delete(agentId);
      return;
    }
    const next = handoffTarget(agentId);
    if (next) {
      driverId = next.id;
      // The finished session is no longer a candidate for later hand-offs.
      agents.delete(agentId);
      enqueue({ reaction: next.reaction ?? 'thinking' });
      return;
    }
    driverId = undefined;
    agents.delete(agentId);
    logDecision(agentId, 'success', 'success');
    enqueue({ reaction: 'success', speechCategory: 'success' });
  }

  function guarded(work) {
    return (...args) => {
      try {
        work(...args);
      } catch (error) {
        debugLog(`OpenPets plugin listener ignored error: ${sanitizeDebugError(error)}`);
      }
    };
  }

  // Observe a waterfall event without interfering: run the pet-side work
  // guarded, then always forward next() untouched (its errors belong to the
  // pipeline itself, not to us).
  function onWaterfall(event, work) {
    ctx.on(event, (payload, next) => {
      guarded(work)(payload);
      return next();
    });
  }

  // User message claimed by an agent -> thinking.
  ctx.on('agent/inbox/claimed', guarded((payload) => {
    claimDriver(agentIdOf(payload), 'thinking', 'thinking');
  }));

  // Agent running state; `idle` = the turn settled.
  ctx.on('agent/status', guarded((payload) => {
    const agentId = agentIdOf(payload);
    if (payload?.status === 'running') {
      agentState(agentId).running = true;
      claimDriver(agentId, 'thinking');
    } else if (payload?.status === 'idle') {
      releaseDriver(agentId);
    }
  }));

  // A tool dispatch finished: on failure -> error; otherwise the agent is
  // about to generate again -> thinking.
  ctx.on('tools/result', guarded((exec, result) => {
    claimDriver(agentIdOf(exec), result?.isError ? 'error' : 'thinking');
  }));

  // An LLM attempt started: the model is generating -> thinking.
  ctx.on('agent/assistant-stream', guarded((payload) => {
    if (payload?.frame?.type === 'start') claimDriver(agentIdOf(payload), 'thinking');
  }));

  // Step or turn errored -> error.
  ctx.on('agent/error', guarded((payload) => {
    claimDriver(agentIdOf(payload), 'error', 'error');
  }));

  // Tool dispatch is about to run -> classify the tool for the pet.
  onWaterfall('tools/pre-execute', (exec) => {
    if (shouldIgnoreTool(exec?.name)) return;
    claimDriver(agentIdOf(exec), classifyToolReaction(exec?.name, exec?.arguments));
  });

  // Waiting on the human: sandbox approvals and structured questions.
  onWaterfall('approval/request', (request) => {
    claimDriver(agentIdOf(request), 'waiting', 'permission');
  });
  onWaterfall('user-questions/request', (request) => {
    claimDriver(agentIdOf(request), 'waiting', 'permission');
  });

  // A delegation started: mark the child as running and let it drive the pet.
  // In-process children are Agents too, so their own events follow; providers
  // without a local Agent (out-of-process) are covered by this pair alone.
  // Whether a child may drive at all is decided in one place, by the
  // `followSubagents` gate inside claimDriver.
  ctx.on('subagent/start', guarded((info) => {
    if (typeof info?.id !== 'string') return;
    children.add(info.id);
    agentState(info.id).running = true;
    claimDriver(info.id, 'working');
  }));

  // A delegation settled: the pet goes back to whatever is still busy.
  ctx.on('subagent/end', guarded((info) => {
    if (typeof info?.id !== 'string') return;
    children.delete(info.id);
    releaseDriver(info.id);
  }));

  // A session left the registry (closed, cancelled, or a child disposed
  // without a lifecycle event): drop its state so it cannot hold the pet.
  ctx.on('agent/disposed', guarded((payload) => {
    releaseDriver(agentIdOf(payload));
  }));

  debugLog(
    `OpenPets DSH bridge loaded (pet=${pet ?? 'default'}, reactions excluded: ${[...excludedReactions].join(',') || 'none'})`,
  );
}

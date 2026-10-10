// openpets-dsh — DSH plugin driving OpenPets desktop-pet reactions.
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
// Throttling: same reaction 10s, speech 20s, permission speech 3s;
// persisted at ~/.local/state/openpets/dsh-hook-throttle.json (separate from
// the OpenCode plugin's file so the two agents can run side by side).

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';

export const name = 'openpets-dsh';

// Single source for the reaction vocabulary: Config schema and runtime filter.
const REACTIONS = [
  'idle', 'thinking', 'working', 'editing', 'running', 'testing',
  'waiting', 'waving', 'success', 'error', 'celebrating',
];
const allowedReactions = new Set(REACTIONS);

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

function shouldSendThrottleKey(key, cooldown) {
  const path = getDefaultThrottlePath();
  const state = readThrottleState(path);
  const previous = typeof state[key] === 'number' ? state[key] : 0;
  if (Date.now() - previous < cooldown) return false;
  state[key] = Date.now();
  writeThrottleState(path, state);
  return true;
}

function markThrottleKey(key) {
  const path = getDefaultThrottlePath();
  const state = readThrottleState(path);
  state[key] = Date.now();
  writeThrottleState(path, state);
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

  async function getLeaseId(ipc, requestedPetId) {
    if (lease && (!lease.expiresAt || lease.expiresAt - Date.now() > 2_000)) return lease.leaseId;
    try {
      const next = await ipc.acquireLease({ requestedPetId });
      lease = { leaseId: next.leaseId, expiresAt: next.expiresAt };
      return next.leaseId;
    } catch (error) {
      debugLog(`OpenPets lease unavailable: ${sanitizeDebugError(error)}`);
      return undefined;
    }
  }

  // The reaction this host last sent — the pet's current state, as we know it.
  let shownReaction;

  function shouldSendReaction(reaction) {
    // A reaction change is a state transition: always send it. Only repeating
    // the same reaction is damped by the persisted cooldown, so rapid tool
    // loops cannot pin the pet in one state.
    if (reaction !== shownReaction) {
      shownReaction = reaction;
      markThrottleKey(`reaction:${reaction}`);
      return true;
    }
    return shouldSendThrottleKey(`reaction:${reaction}`, reactionCooldownMs);
  }

  async function deliver(decision) {
    const reaction = decision.reaction;
    try {
      const shouldSpeak = decision.speechCategory ? shouldSendSpeech(decision.speechCategory) : false;
      const shouldReact = shouldSendReaction(reaction);
      if (!shouldSpeak && !shouldReact) return;
      client ??= createOpenPetsClient({
        discoveryPath: config?.discoveryPath || undefined,
        connectTimeoutMs: config?.connectTimeoutMs,
        responseTimeoutMs: config?.responseTimeoutMs,
      });
      const leaseId = pet ? await getLeaseId(client, pet) : undefined;
      if (decision.speechCategory && shouldSpeak) {
        await client.say(validateHookSpeech(pickHookSpeech(decision.speechCategory)), { reaction, leaseId });
        return;
      }
      await client.react(reaction, { leaseId });
    } catch (error) {
      debugLog(`OpenPets plugin ignored error: ${sanitizeDebugError(error)}`);
    }
  }

  function run(decision) {
    if (!decision?.reaction) return;
    if (excludedReactions.has(decision.reaction)) return;
    debugLog(`OPENPETS_DECISION reaction=${decision.reaction} speech=${decision.speechCategory ?? ''}`);
    queueMicrotask(() => {
      void deliver(decision);
    });
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
  ctx.on('agent/inbox/claimed', guarded(() => {
    run({ reaction: 'thinking', speechCategory: 'thinking' });
  }));

  // Agent running state. `idle` = the turn settled -> success (V1 parity:
  // session.idle / session.execution.succeeded).
  ctx.on('agent/status', guarded((payload) => {
    if (payload?.status === 'running') run({ reaction: 'thinking' });
    else if (payload?.status === 'idle') run({ reaction: 'success', speechCategory: 'success' });
  }));

  // A tool dispatch finished: on failure -> error; otherwise the agent is
  // about to generate again -> thinking.
  ctx.on('tools/result', guarded((exec, result) => {
    if (result?.isError) run({ reaction: 'error' });
    else run({ reaction: 'thinking' });
  }));

  // An LLM attempt started: the model is generating -> thinking.
  ctx.on('agent/assistant-stream', guarded((payload) => {
    if (payload?.frame?.type === 'start') run({ reaction: 'thinking' });
  }));

  // Step or turn errored -> error.
  ctx.on('agent/error', guarded(() => {
    run({ reaction: 'error', speechCategory: 'error' });
  }));

  // Tool dispatch is about to run -> classify the tool for the pet.
  onWaterfall('tools/pre-execute', (exec) => {
    if (shouldIgnoreTool(exec?.name)) return;
    run({ reaction: classifyToolReaction(exec?.name, exec?.arguments) });
  });

  // Waiting on the human: sandbox approvals and structured questions.
  onWaterfall('approval/request', () => {
    run({ reaction: 'waiting', speechCategory: 'permission' });
  });
  onWaterfall('user-questions/request', () => {
    run({ reaction: 'waiting', speechCategory: 'permission' });
  });

  debugLog(`OpenPets DSH bridge loaded (pet=${pet ?? 'default'}, reactions excluded: ${[...excludedReactions].join(',') || 'none'})`);
}

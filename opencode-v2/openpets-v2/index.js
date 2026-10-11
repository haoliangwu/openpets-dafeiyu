// OpenPets OpenCode plugin — V2 port (local).
// Ports @open-pets/opencode@4.0.0 V1 server API (dist/plugin.js +
// opencode-plugin-runtime.js) to the OpenCode V2 plugin API:
// default export { id, setup(ctx) }, hooks registered on the context.
//
// Transport: local IPC to the OpenPets desktop app, exactly as V1
// (JSONL over a Unix socket, token from the discovery file
// ~/Library/Application Support/OpenPets/runtime/ipc.json). NOT MCP.
// Events: terse. Behavior parity with V1 unless noted in comments.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export const openPetsPluginId = "openpets";

const speechCooldownMs = 20_000;
const reactionCooldownMs = 10_000;

const allowedReactions = new Set([
  "idle", "thinking", "working", "editing", "running", "testing",
  "waiting", "waving", "success", "error", "celebrating",
]);

// Speech pools cloned from @open-pets/agent-events@4.0.0 (hookSpeechPools).
// The V1 "permission" pool is not ported: V2 emits no permission.asked event.
const hookSpeechPools = {
  thinking: ["Thinking it through", "Let me check", "On it", "Working it out"],
  success: ["Done", "That worked", "All set", "Nice, finished"],
  error: ["Something failed", "Needs another look", "Hit a snag", "Not quite there"],
};

const SESSION_NONCE = randomUUID();

function pickHookSpeech(category, random = Math.random) {
  const pool = hookSpeechPools[category];
  return pool[Math.max(0, Math.min(pool.length - 1, Math.floor(random() * pool.length)))] ?? pool[0] ?? "Working";
}

// validateHookSpeech@4.0.0: length/single-line/code-like checks plus the
// V1 URL (http(s) and www.), path-like, and secret-looking assignment rules.
export function validateHookSpeech(message) {
  if (message.length < 1 || message.length > 140) throw new Error("Hook speech length is invalid.");
  if (/\r|\n/.test(message)) throw new Error("Hook speech must be single line.");
  if (/```|\b(function|const|let|var|class|import|export)\b|[{};]/.test(message))
    throw new Error("Hook speech looks code-like.");
  if (/https?:\/\/\S+|www\.\S+/.test(message)) throw new Error("Hook speech contains a URL.");
  if (/(^|\s)(?:~|\.{1,2}|[A-Za-z]:)?[\\/][^\s]+/.test(message)) throw new Error("Hook speech contains a path.");
  if (/\b(api[_-]?key|secret|password|token)\s*[:=]/i.test(message)) throw new Error("Hook speech contains a secret-looking assignment.");
  return message;
}

function getDiscoveryFilePath() {
  if (process.env.OPENPETS_DISCOVERY_FILE) return process.env.OPENPETS_DISCOVERY_FILE;
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "OpenPets", "runtime", "ipc.json");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "OpenPets", "runtime", "ipc.json");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "OpenPets", "runtime", "ipc.json");
}

function readDiscoveryFile(path = getDiscoveryFilePath()) {
  const raw = readFileSync(path, "utf8");
  const value = JSON.parse(raw);
  if (typeof value.endpoint !== "string" || typeof value.token !== "string")
    throw new Error("OpenPets discovery file is invalid.");
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
    let buffer = "";
    let settled = false;
    const connectTimer = setTimeout(() => finish(new Error("Timed out connecting to OpenPets.")), options.connectTimeoutMs);
    const responseTimer = setTimeout(() => finish(new Error("Timed out waiting for OpenPets response.")), options.responseTimeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      try {
        socket.write(`${request}\n`);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let parsed;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (parsed.ok === true) finish(undefined, parsed.result);
      else finish(new Error(parsed?.error?.message ?? "OpenPets request failed."));
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("OpenPets closed the IPC connection before responding."));
    });
  });
}

export function createOpenPetsClient(options = {}) {
  const send = (method, params) =>
    sendRequest(method, params, {
      discoveryPath: options.discoveryPath,
      connectTimeoutMs: options.connectTimeoutMs ?? 500,
      responseTimeoutMs: options.responseTimeoutMs ?? 500,
    });
  return {
    acquireLease: (leaseOptions) =>
      send("lease.acquire", {
        requestedPetId: leaseOptions?.requestedPetId,
        clientPid: process.pid,
        sessionNonce: SESSION_NONCE,
      }),
    react: (reaction, reactOptions) =>
      send("pet.react", { reaction, ...(reactOptions?.leaseId === undefined ? {} : { leaseId: reactOptions.leaseId }) }),
    say: (message, sayOptions) =>
      send("pet.say", {
        message,
        ...(sayOptions?.reaction === undefined ? {} : { reaction: sayOptions.reaction }),
        ...(sayOptions?.leaseId === undefined ? {} : { leaseId: sayOptions.leaseId }),
      }),
  };
}

export function validateOpenPetsPetArg(value) {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length < 1) throw new Error("Invalid OpenPets pet id.");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) throw new Error("Invalid OpenPets pet id.");
  return trimmed;
}

export function sanitizeOpenCodeExcludedReactions(excludeReactions) {
  if (!excludeReactions) return [];
  return [...new Set(excludeReactions.filter((reaction) => typeof reaction === "string" && allowedReactions.has(reaction)))];
}

export function shouldIgnoreOpenPetsTool(toolName) {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
  return (
    /(?:^|[_:-])openpets_(?:openpets_)?(?:status|say|react)$/.test(normalized) ||
    /^openpets_(?:status|say|react)$/.test(normalized)
  );
}

export function classifyOpenCodeToolReaction(toolName, args) {
  const normalized = toolName.toLowerCase();
  if (/edit|write|patch|apply_patch/.test(normalized)) return "editing";
  if (/bash|shell|terminal/.test(normalized)) return isTestLikeToolArgs(args) ? "testing" : "running";
  return "working";
}

function isTestLikeToolArgs(args) {
  const command = isRecord(args) && typeof args.command === "string" ? args.command.slice(0, 300) : "";
  return /\b(test|vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/i.test(command);
}

// V2 bus events are { id, created, type, durable, location, data }; the
// payload/data wrapper lookups tolerate older shapes defensively.
function getEventField(event, key) {
  if (!isRecord(event)) return undefined;
  if (event[key] !== undefined) return event[key];
  if (isRecord(event.payload) && event.payload[key] !== undefined) return event.payload[key];
  if (isRecord(event.data) && event.data[key] !== undefined) return event.data[key];
  return undefined;
}

function getEventType(event) {
  const type = getEventField(event, "type");
  return typeof type === "string" ? type : undefined;
}

// Bus types handled by the arbitration in createOpenPetsOpenCodeHooks:
//   session.execution.succeeded  data {sessionID} — run finished; releases
//     the driver (hands the pet to a still-running session, else "success").
//   session.execution.failed     data {sessionID} — run failed; claims the
//     driver with "error" + speech.
//   session.inbox.delivered      data {sessionID, inboxID} — user message;
//     marks the session running and claims the driver with "thinking".

function getDefaultOpenCodeThrottlePath() {
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "OpenPets", "opencode-hook-throttle.json");
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  if (stateHome) return join(stateHome, "openpets", "opencode-hook-throttle.json");
  return join(tmpdir(), `openpets-${safeUid()}`, "opencode-hook-throttle.json");
}

function shouldSendSpeech(category, options) {
  const now = options.now?.() ?? Date.now();
  return shouldSendThrottleKey(category, speechCooldownMs, now, options.throttlePath ?? getDefaultOpenCodeThrottlePath());
}

function shouldSendReaction(reaction, options) {
  const now = options.now?.() ?? Date.now();
  return shouldSendThrottleKey(`reaction:${reaction}`, reactionCooldownMs, now, options.throttlePath ?? getDefaultOpenCodeThrottlePath());
}

function markThrottleKey(key, options) {
  const now = options.now?.() ?? Date.now();
  const path = options.throttlePath ?? getDefaultOpenCodeThrottlePath();
  const acquired = acquireThrottleLock(path);
  try {
    const state = readThrottleState(path);
    state[key] = now;
    writeThrottleState(path, state);
  } finally {
    releaseThrottleLock(acquired);
  }
}

// Cross-process lock: multiple hosts (TUI + desktop, or host + another agent)
// share the throttle state file. The read-check-write in
// shouldSendThrottleKey is not atomic across processes: both can read the
// same stale timestamp, both send, and a later write clobbers the other's
// timestamp (lost update -> duplicate speech later). O_EXCL lockfile with
// stale theft; on any lock trouble we proceed unlocked (best effort,
// throttling must never break hooks).
const THROTTLE_LOCK_STALE_MS = 1_000;
const THROTTLE_LOCK_MAX_TRIES = 200; // ~1 s worst case, then unlocked.

function acquireThrottleLock(path) {
  const lockPath = `${path}.lock`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {}
  for (let attempt = 0; attempt < THROTTLE_LOCK_MAX_TRIES; attempt++) {
    try {
      return { fd: openSync(lockPath, "wx"), lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") return { fd: undefined, lockPath };
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

function shouldSendThrottleKey(key, cooldown, now, path) {
  const acquired = acquireThrottleLock(path);
  try {
    const state = readThrottleState(path);
    const previous = typeof state[key] === "number" ? state[key] : 0;
    if (now - previous < cooldown) return false;
    state[key] = now;
    writeThrottleState(path, state);
    return true;
  } finally {
    releaseThrottleLock(acquired);
  }
}

function readThrottleState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return {};
    const state = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        (key === "thinking" || key === "success" || key === "error" || key === "permission" || key.startsWith("reaction:")) &&
        typeof value === "number" && Number.isFinite(value)
      )
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
    writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch {
    // Best effort only; throttling must never break hooks.
  }
}

function safeUid() {
  try {
    return String(userInfo().uid);
  } catch {
    return "user";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function sanitizeDebugError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .slice(0, 200);
}

// Single debug logger for the whole plugin. Gated on
// options.debug === true || OPENPETS_DEBUG === "1", unless options.debugLog
// overrides it.
function createDebugLog(options = {}) {
  if (typeof options.debugLog === "function") return options.debugLog;
  const debug = options.debug === true || process.env.OPENPETS_DEBUG === "1";
  return (message) => { if (debug) process.stderr.write(`${message}\n`); };
}

export function createOpenPetsOpenCodeHooks(options = {}) {
  const pet = options.pet === undefined ? undefined : validateOpenPetsPetArg(options.pet);
  const clientFactory = options.clientFactory ?? (() => createOpenPetsClient({ connectTimeoutMs: 500, responseTimeoutMs: 500 }));
  const debugLog = createDebugLog(options);
  const excludedReactions = new Set(sanitizeOpenCodeExcludedReactions(options.excludeReactions));
  let client;
  let lease;

  const getLeaseId = async (requestedPetId) => {
    if (lease && (!lease.expiresAt || lease.expiresAt - Date.now() > 2_000)) return lease.leaseId;
    try {
      const next = await client.acquireLease({ requestedPetId });
      lease = { leaseId: next.leaseId, expiresAt: next.expiresAt };
      return next.leaseId;
    } catch (error) {
      debugLog(`OpenPets OpenCode lease unavailable: ${sanitizeDebugError(error)}`);
      return undefined;
    }
  };

  // ---- Send queue: serialized, latest-wins ------------------------------
  // Sessions fire concurrently, so sends must not race: one request is in
  // flight at a time, and a decision that arrives while an older one is
  // still queued replaces it (the pet only ever needs the newest state).
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

  async function send(decision) {
    const { reaction, speechCategory } = decision;
    if (excludedReactions.has(reaction)) return;
    try {
      // A reaction change is a state transition: always send it. Only
      // repeating the same reaction is damped by the persisted cooldown
      // (which doubles as the keep-alive heartbeat), so rapid tool loops
      // cannot pin the pet in one state.
      const speak = speechCategory ? shouldSendSpeech(speechCategory, options) : false;
      let react;
      if (reaction !== shownReaction) {
        shownReaction = reaction;
        markThrottleKey(`reaction:${reaction}`, options);
        react = true;
      } else {
        react = shouldSendReaction(reaction, options);
      }
      if (!speak && !react) return;
      client ??= clientFactory();
      const leaseId = pet ? await getLeaseId(pet) : undefined;
      if (speak) {
        await client.say(validateHookSpeech(pickHookSpeech(speechCategory, options.random)), { reaction, leaseId });
        return;
      }
      await client.react(reaction, { leaseId });
    } catch (error) {
      debugLog(`OpenPets OpenCode plugin ignored error: ${sanitizeDebugError(error)}`);
    }
  }

  // ---- Session arbitration ----------------------------------------------
  // Mirrors openpets-dsh/index.js: one session at a time drives the pet —
  // whoever produced the most recent event. State is per session, so
  // concurrent sessions cannot stomp each other. When the driver goes idle
  // the pet hands back to a still-running session instead of flashing
  // "success" over its work; idle with nobody left behind settles "success".
  const sessions = new Map();
  let driverId;

  // Sessions have no lifecycle end on the V2 bus (a closed session just
  // stops emitting), so an entry without activity for this long is claimed
  // stale and dropped.
  const staleSessionMs = 10 * 60_000;

  // Bus events carry data.sessionID; tool hooks do not identify a session.
  const unscopedSessionId = "__unscoped__";

  function sweepStaleSessions() {
    if (sessions.size === 0) return;
    const cutoff = Date.now() - staleSessionMs;
    for (const [id, state] of sessions) {
      if (state.lastEventAt > cutoff) continue;
      sessions.delete(id);
      if (driverId === id) driverId = undefined;
    }
  }

  function isAnotherSessionRunning(sessionId) {
    for (const [id, state] of sessions) {
      if (id !== sessionId && state.running) return true;
    }
    return false;
  }

  function sessionState(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      // A brand-new entry is fresh by definition: it must not be swept as
      // stale before its first event is even recorded.
      state = { running: false, reaction: undefined, lastEventAt: Date.now() };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function newestRunningSession(excludeId) {
    let best;
    for (const [id, state] of sessions) {
      if (id === excludeId || !state.running) continue;
      if (!best || state.lastEventAt > best.lastEventAt) best = { id, reaction: state.reaction };
    }
    return best;
  }

  // Any session we have heard from and not seen go idle.
  function newestKnownSession(excludeId) {
    let best;
    for (const [id, state] of sessions) {
      if (id === excludeId || id === unscopedSessionId) continue;
      if (!best || state.lastEventAt > best.lastEventAt) best = { id, reaction: state.reaction };
    }
    return best;
  }

  // Where the pet goes when its driver stops: a session still running, else
  // any session we have heard from without a terminal event.
  function handoffTarget(sessionId) {
    return newestRunningSession(sessionId) ?? newestKnownSession(sessionId);
  }

  function claimDriver(sessionId, reaction, speechCategory) {
    sweepStaleSessions();
    const running = sessionId === unscopedSessionId || sessions.get(sessionId)?.running === true;
    // A straggler from a session that is not running is ignored outright: it
    // must neither drive the pet nor leave an entry that a later hand-off
    // would mistake for a session that is still busy.
    if (!running && isAnotherSessionRunning(sessionId)) return;
    const state = sessionState(sessionId);
    state.lastEventAt = Date.now();
    state.reaction = reaction;
    driverId = sessionId;
    debugLog(`OPENPETS_DECISION session=${sessionId} reaction=${reaction} speech=${speechCategory ?? ""}`);
    enqueue({ reaction, speechCategory });
  }

  function releaseDriver(sessionId) {
    sweepStaleSessions();
    const state = sessionState(sessionId);
    state.running = false;
    state.reaction = undefined;
    state.lastEventAt = Date.now();
    // Session that was not driving: it must not steal the pet by going idle.
    if (driverId !== undefined && driverId !== sessionId) {
      sessions.delete(sessionId);
      return;
    }
    const next = handoffTarget(sessionId);
    if (next) {
      driverId = next.id;
      // The finished session is no longer a candidate for later hand-offs.
      sessions.delete(sessionId);
      enqueue({ reaction: next.reaction ?? "thinking" });
      return;
    }
    driverId = undefined;
    sessions.delete(sessionId);
    debugLog(`OPENPETS_DECISION session=${sessionId} reaction=success speech=success`);
    enqueue({ reaction: "success", speechCategory: "success" });
  }

  return {
    event(input) {
      try {
        const event = input?.event;
        const type = getEventType(event);
        if (!isRecord(event)) return;
        const sessionIdField = getEventField(event, "sessionID");
        const sessionId = typeof sessionIdField === "string" && sessionIdField ? sessionIdField : unscopedSessionId;
        if (type === "session.inbox.delivered") {
          // A user message arrived: that session is live and generating.
          sessionState(sessionId).running = true;
          claimDriver(sessionId, "thinking", "thinking");
        } else if (type === "session.execution.succeeded") {
          releaseDriver(sessionId);
        } else if (type === "session.execution.failed") {
          claimDriver(sessionId, "error", "error");
        }
      } catch (error) {
        debugLog(`OpenPets OpenCode event ignored error: ${sanitizeDebugError(error)}`);
      }
    },
    "tool.execute.before"(input, output) {
      try {
        const tool = typeof input?.tool === "string" ? input.tool : "";
        if (shouldIgnoreOpenPetsTool(tool)) return;
        claimDriver(unscopedSessionId, classifyOpenCodeToolReaction(tool, output?.args));
      } catch (error) {
        debugLog(`OpenPets OpenCode tool hook ignored error: ${sanitizeDebugError(error)}`);
      }
    },
  };
}

// --- V2 entry ---------------------------------------------------------
// V2 plugin contract per opencode v2.0.25 PluginModule schema:
// default export { id, setup(ctx) | effect(ctx) }.
export default {
  id: openPetsPluginId,
  setup(ctx) {
    const options = ctx.options ?? {};
    const hooks = createOpenPetsOpenCodeHooks(options);
    const debugLog = createDebugLog(options);

    const cleanups = [];

    if (typeof ctx.event?.subscribe === "function") {
      // V1 event(input) → ctx.event.subscribe() in V2 is an ASYNC ITERATOR
      // (public server event stream), not a callback register. Events only
      // arrive when the iterable is consumed; passing a callback silently
      // dropped every event. Events are { id, created, type, durable,
      // location, data } — payload lives in `data` (see classifier).
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            hooks.event({ event });
          }
        } catch (error) {
          debugLog(`OpenPets OpenCode event stream ended: ${sanitizeDebugError(error)}`);
        }
      })();
      cleanups.push(() => controller.abort());
    }

    if (typeof ctx.tool?.hook === "function") {
      // V1 "tool.execute.before"(input, output) -> ctx.tool.hook("execute.before", event).
      // V2 event carries { tool, input, ... } (input = args payload).
      // Registered AFTER the event-stream branch without returning early:
      // the previous early return left the tool hooks dead, so the pet never
      // got "editing" from this path (and never any fallback).
      ctx.tool.hook("execute.before", (event) => {
        try {
          const input = { tool: typeof event?.tool === "string" ? event.tool : "" };
          const output = { args: event?.input };
          hooks["tool.execute.before"](input, output);
        } catch (error) {
          debugLog(`OpenPets OpenCode tool hook ignored error: ${sanitizeDebugError(error)}`);
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  },
};

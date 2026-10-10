# openpets-dsh

A DSH (DeepSeek Harness) plugin that drives an OpenPets desktop pet in real
time while DSH works: the pet **thinks** while the model generates, **works**
while tools run, **celebrates** when a turn succeeds, and sulks when it
fails. Port of the OpenCode OpenPets plugin (`@open-pets/opencode@4.0.0`, V2
port in `../opencode-v2/`) to the Cordis plugin API that DSH hosts run.

- **Live state machine.** Eight host events mapped to reactions — thinking /
  working / editing / running / testing / success / error / waiting (table
  below).
- **Never pinned.** A reaction *change* is always sent as a state
  transition; repeating the same reaction re-fires every 10 s as a
  keep-alive. Speech is damped 20 s (approval 3 s).
- **Pipeline-safe.** Waterfall events always forward `next()` untouched;
  every IPC failure — including synchronous write failures — is swallowed.
- **Self-ignoring.** OpenPets' own MCP tools (`openpets_say` /
  `openpets_react` / `openpets_status`) never trigger reactions.
- **Zero-config transport.** JSONL over the OpenPets app's local Unix
  socket; endpoint and token read from the app's discovery file.

## What the pet does

| DSH event | Pet reaction | Speech |
|---|---|---|
| `agent/inbox/claimed` (user message) | thinking | "On it" … |
| `agent/status` running | thinking | — |
| `agent/assistant-stream` frame `start` (model generating) | thinking | — |
| `agent/status` idle (turn finished) | success | "Done" … |
| `agent/error` | error | "Hit a snag" … |
| `tools/pre-execute` — edit/write/patch | editing | — |
| `tools/pre-execute` — bash/shell/terminal | running (testing if command looks like a test run) | — |
| `tools/pre-execute` — any other tool | working | — |
| `tools/result` success | thinking (agent resumes generating) | — |
| `tools/result` with `isError` | error | — |
| `approval/request`, `user-questions/request` | waiting | "Approval needed" |

The alternation working (tool running) → thinking (model generating) keeps
the pet from being pinned in "working" for the whole turn, the flaw the
OpenCode V1 plugin also had (its `tool.execute.after` hook was quiet).

## Install

From this repo's root (or any checkout of it):

```sh
dsh plugin --profile desktop add ./openpets-dsh
```

The command links the checkout
(`link:/…/openpets-dsh`) into `$DSH_HOME/profiles/desktop/`, appends
`openpets-dsh` to the profile's bundle list, and — with HMR active — loads
it without a restart. The same works through the GUI (Creator mode →
Plugin Manager) with the path to this folder.

## Configure

Override the `openpets` row from the profile's `cordis.patch.yml`:

```yaml
- id: openpets
  name: openpets-dsh
  config:
    pet: dafeiyu            # lease this pet id (empty = app default)
    excludeReactions: [idle] # reactions to never send
    debug: true              # decision/IPC-error logging (or OPENPETS_DEBUG=1)
    # discoveryPath: ''      # override the discovery file path
    # connectTimeoutMs: 500
    # responseTimeoutMs: 500
```

Schema defaults: `pet: ''`, `excludeReactions: []`, `debug: false`,
`discoveryPath: ''`, `connectTimeoutMs: 500`, `responseTimeoutMs: 500`.

## Throttling

A reaction change is a state transition: always sent. Repeating the same
reaction is damped 10 s (a keep-alive heartbeat), speech 20 s, permission
speech 3 s. State persists at
`~/.local/state/openpets/dsh-hook-throttle.json` — separate from the
OpenCode plugin's file, so both agents can run side by side.

## Uninstall / disable

```sh
dsh plugin --profile desktop remove openpets-dsh
```

or toggle the `openpets` entry in the GUI Plugin Manager.

## Developing

The desktop profile's `cordis.patch.yml` adds this folder to the HMR module
watch roots (base HMR ships with `root: []`, i.e. no source watching, and a
`link:`-installed package lives outside the profile anyway):

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root:
      - /Users/haoliang.wu/lyon/openpets-dafeiyu/openpets-dsh
```

With that in place, edits to `index.js` hot-reload the running plugin — no
app restart. Watch the effect in
`~/.local/state/openpets/dsh-hook-throttle.json`.

Dependency: `@deepseek-ai/schemastery` (for the `Config` schema) — run
`pnpm install` in this folder after cloning.

## Notes

- The plugin never throws into the DSH pipelines: waterfall events
  (`tools/pre-execute`, `approval/request`, `user-questions/request`)
  always forward `next()` untouched (errors there belong to the pipeline
  itself); every pet-side failure is swallowed, optionally logged with
  `debug: true`.
- If the OpenPets app is not running, the plugin stays quiet; events are
  still consumed and throttled, nothing crashes.

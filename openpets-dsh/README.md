# openpets-dsh — OpenPets pet bridge for DSH

A DSH (DeepSeek Harness) plugin that drives the OpenPets desktop pet in
real time while DSH works. Port of the OpenCode OpenPets plugin
(`@open-pets/opencode@4.0.0`, V2 port in `../opencode-v2/openpets-v2/`)
to the Cordis plugin API that DSH hosts run.

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

The reaction set alternates during a turn: `working`/`editing`/`running`
only while a tool actually runs, `thinking` whenever the model generates
(after each tool result, and at each LLM attempt start), `success` when the
agent goes idle. This fixes the "pet pinned in working all turn" issue the
OpenCode V1 plugin also had (its `tool.execute.after` hook was quiet).

Throttling: a reaction **change** (state transition) is always sent; repeating
the same reaction is damped 10 s, speech 20 s (permission speech 3 s),
persisted at `~/.local/state/openpets/dsh-hook-throttle.json` — separate
from the OpenCode plugin's file, so both agents can run side by side. OpenPets'
own MCP tools (`openpets_say` / `openpets_react` / `openpets_status`) are
ignored, so the pet never reacts to itself.

Transport: JSONL over the OpenPets app's local Unix socket, endpoint and
token from the discovery file (`~/Library/Application Support/OpenPets/
runtime/ipc.json` on macOS). Not MCP. Optional pet lease via
`lease.acquire` before `pet.react` / `pet.say`.

## Install (already applied to the `desktop` profile)

```sh
# from this repo root
dsh plugin --profile desktop add ./openpets-dsh
```

or via the Plugin Manager tool / GUI (Creator mode → Plugin Manager) with
the path to this folder. It links the checkout
(`link:/…/openpets-dafeiyu/openpets-dsh`) and appends `openpets-dsh` to the
profile's bundle list. HMR applies it without a restart.

## Configure

Override the `openpets` row from the profile's `cordis.patch.yml`:

```yaml
- insert:
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

## Uninstall / disable

```sh
dsh plugin --profile desktop remove openpets-dsh
```

or toggle the `openpets` entry in the GUI Plugin Manager.

## Developing

The `desktop` profile's `cordis.patch.yml` adds this folder to the HMR module
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
app restart. Watch the effect in `~/.local/state/openpets/dsh-hook-throttle.json`.

## Notes

- The plugin never throws into the DSH pipelines: waterfall events
  (`tools/pre-execute`, `approval/request`, `user-questions/request`)
  always forward `next()` untouched (errors there belong to the pipeline
  itself), every pet-side failure — including synchronous IPC write
  failures — is swallowed, optionally logged with `debug: true`.
- If the OpenPets app is not running, the plugin stays quiet; events are
  still consumed and throttled, nothing crashes.

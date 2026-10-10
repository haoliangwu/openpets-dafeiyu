# opencode-v2 — OpenCode V2 integration assets

Assets for integrating OpenPets with OpenCode V2.

## openpets-v2/ — local V2 plugin

A port of `@open-pets/opencode@4.0.0` (written for the OpenCode V1 plugin
API) to the V2 plugin API, since upstream has not shipped a V2-compatible
release. Behavior is ported 1:1 from the upstream dist:

- Subscribes to the OpenCode event stream and tool hooks, and drives pet
  reactions/speech through the OpenPets desktop app's local IPC (Unix
  socket, lease-based).
- Reaction cooldown 10s, speech 20s, persisted at
  `~/.local/state/openpets/opencode-hook-throttle.json`.
- Event mapping (V2 bus events, verified against opencode 2.0.25):
  `session.inbox.delivered` (user message delivered) → "thinking";
  `session.execution.succeeded` → "success"; `session.execution.failed` →
  "error". V2 has no `chat.message` hook and no `message.updated`,
  `permission.asked`, `session.idle`/`session.status` or `session.error`
  events, so those V1 paths are not ported.
- Tool classifier (`tool.execute.before`): edit/write/patch tools →
  "editing"; bash/shell tools with a test-like command (`test`, `vitest`,
  `jest`, `pytest`, `npm test`, ...) → "testing"; other bash/shell tools →
  "running"; all other tools → "working".

Install locally:

1. Copy `openpets-v2/` to `~/.config/opencode/plugins/openpets-v2/`.
2. Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    // ...existing entries...
    { "package": "/Users/<you>/.config/opencode/plugins/openpets-v2", "options": {} }
  ]
}
```

3. Restart OpenCode (`opencode service restart`).

## openpets.md — agent instructions

OpenPets MCP usage rules for agents (when to call `openpets_say` /
`openpets_react`, keep messages brief and non-sensitive). OpenCode V2 does
not resolve the `instructions` config field — put this content in your
global `AGENTS.md` instead of referencing the file.

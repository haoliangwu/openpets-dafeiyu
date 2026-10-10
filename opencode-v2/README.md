# opencode-v2 — OpenCode V2 integration assets

Assets for making an OpenPets desktop pet react to OpenCode V2: a local
plugin port plus agent instructions for the OpenPets MCP tools. Ports
`@open-pets/opencode@4.0.0` (written for the OpenCode V1 plugin API) to the
V2 plugin API, since upstream has not shipped a V2-compatible release.

- **Behavior parity.** Subscribes to OpenCode events (permission asked,
  tool execute, session status/idle, user message) and drives pet
  reactions/speech through the OpenPets desktop app's local IPC (Unix
  socket, lease-based). Reaction cooldown 10 s, speech 20 s, persisted at
  `~/.local/state/openpets/opencode-hook-throttle.json`.
- **Known approximation.** V2 has no `chat.message` hook, so "thinking" is
  triggered from `message.updated` events with `info.role === "user"`.

## Install

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

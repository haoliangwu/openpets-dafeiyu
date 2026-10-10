# 大肥鱼 (dafeiyu)

A fan-made OpenPets desktop pet: a chibi whale-girl maid inspired by the
DeepSeek mascot "小鲸 / DeepSeek酱" — navy hair with hook-shaped ahoge,
whale-fin ears, white frilled headdress, rice bowl, and a whale-fluke tail.

Idle, run (left/right), wave, jump, fail, wait, task-work and review —
57 frames across 9 animation rows on the standard 1536×1872 OpenPets V1 atlas.

## Install

```bash
npx -y install-pet dafeiyu
# or, from a local clone / downloaded zip:
openpets install --from-folder ./dist/dafeiyu
openpets install --from-zip ./dist/dafeiyu.zip
```

## Package

- `dist/dafeiyu/pet.json` + `dist/dafeiyu/spritesheet.webp` — installable pet folder
- `dist/dafeiyu.zip` — zipped package (files at zip root)
- `previews/` — per-state animation GIFs + contact sheet
- `opencode-v2/` — OpenCode V2 integration assets (plugin port + agent instructions)
- `openpets-dsh/` — DSH plugin bundle: drives the pet from DSH agent events
  (installed in the `desktop` profile)

Built with the [openpet-hatchery](https://github.com/chenmi319/openpet-hatchery) pipeline.

## Rights

Fan-made unofficial fan art. Character artwork was AI-generated, derived from
the DeepSeek mascot design, then assembled and packaged into the OpenPets
format. Not affiliated with or endorsed by DeepSeek. No ownership claimed over
DeepSeek's name, trademarks, or the original character artist's rights.

# README demo recordings

Each GIF in `assets/demos/` is one real session: the `gatekeeper` example, this
server, and a real model. Output is never edited. Only retakes and a
per-scenario idle cap shape a GIF, so model pauses are shortened and nothing
else changes. The cap defaults to 0.7 s; a scenario raises it with `DEMO_IDLE`.

## Setup

In WSL, once, without root:

```sh
bash scripts/demos/install-tools.sh
```

Built with asciinema 3.2.1, agg 1.9.0, and gifsicle 1.96. Run `npm run build` at
the repository root first.

## Record

From PowerShell, with `GEMINI_API_KEY` set:

```powershell
$env:WSLENV='GEMINI_API_KEY'; wsl bash /mnt/c/filesystem-mcp/scripts/demos/record.sh undo
```

| Exit | Meaning                                          |
| :--- | :----------------------------------------------- |
| 0    | The check passed; `assets/demos/<slug>.gif` made |
| 1    | Failed take; the cast is in `~/.cache/fs-demos`  |
| 3    | API or stall failure, which is not a take        |

A passing check does not make a good GIF. Look at the frames too: 30 s or less,
readable, with the payoff on the last frame.

Fixtures hold only fake data, and their contents go to the model provider.

## Scenarios

`scenarios/<slug>.sh` defines `fixture`, `script`, and `check`, using the helpers
in `lib.sh`.

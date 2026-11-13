# Hippo

A terminal-first second brain for ADHD brains. Dump a thought with one command, and agents file it, track its deadline, remember where you left off, and plan your morning. You never organize anything yourself.

## Quick start (macOS)

Needs Node 22.13 or newer (`node -v`).

```bash
cd hippo
npm install
npm run build
npm link -w hippo-cli        # puts `hippo` on your PATH
hippo doctor                 # checks everything
hippo d "cs161 hw4 due friday 11:59pm, ask navid about the esp32 wiring"
```

Without an API key everything still works with the offline filer. It is rule-based, so it is less clever: it will not know that Navid belongs to your Smart Bin project.

## Connect a model

Claude is the default. Store the key in the macOS Keychain so the background job can read it too, since launchd jobs do not see your shell's environment variables:

```bash
security add-generic-password -a "$USER" -s hippo-anthropic -w 'sk-ant-...'
hippo config anthropic.apiKeyCommand "security find-generic-password -s hippo-anthropic -w"
hippo doctor
```

Other providers:

```bash
# Gemini
security add-generic-password -a "$USER" -s hippo-gemini -w 'AIza...'
hippo config gemini.apiKeyCommand "security find-generic-password -s hippo-gemini -w"
hippo config provider gemini

# A local model through Ollama (fully offline, no key)
hippo config provider openai
hippo config openai.baseUrl http://localhost:11434/v1
hippo config openai.fastModel qwen2.5:7b
hippo config openai.smartModel qwen2.5:7b

# No model at all
hippo config provider offline
```

`ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `OPENAI_API_KEY` also work for the CLI, but not for the background job.

## Turn on nudges and the terminal greeting

```bash
hippo setup-mac
```

This installs a launchd job that runs `hippo tick` every 10 minutes and adds a two-line greeting to your `~/.zshrc`. The tick retries failed dumps, writes the morning brief after 7:30, and sends deadline nudges. Remove both with `hippo setup-mac --uninstall`.

Notifications come from `osascript` by default. `brew install terminal-notifier` gives nicer ones.

## Read everything in Obsidian

```bash
hippo config mirrorDir "~/Documents/Lyfe/Hippo"     # use your vault's real path
```

The mirror is one-way: `Tasks.md`, `Ideas.md`, `Projects/<slug>.md` and `Daily/<date>.md` are regenerated after each change. Edit through the CLI, not the files.

## Tell the planner about your fixed weekly blocks

Edit `~/.hippo/config.json` (see `config.example.json`):

```json
{
  "schedule": {
    "dayStart": "07:00",
    "dayEnd": "23:00",
    "blocks": [
      { "days": ["mon", "wed", "fri"], "start": "09:00", "end": "09:50", "label": "CS161 lecture" },
      { "days": ["tue"], "start": "16:20", "end": "23:00", "label": "Duty shift" }
    ]
  }
}
```

The brief only schedules focus blocks in the gaps.

## Daily use

| Command | What it does |
| --- | --- |
| `hippo` or `hippo d <text>` | Brain dump. No text opens a prompt, and piped stdin works too |
| `hippo today` | Morning brief. `--fresh` regenerates it |
| `hippo where [project]` | Where you left off. No argument means the project you touched last |
| `hippo park "project: did X, next: Y"` | Save where you are before switching away |
| `hippo tasks` | Open tasks by overdue, today, this week, later, someday |
| `hippo done <id or words>` | Complete a task. Asks if the words match several |
| `hippo snooze <id> <2h, tomorrow, ...>` | Quiet a task's nudges until later |
| `hippo undo` | Reverse the last dump or command |
| `hippo search <words>` | Ranked search across everything |
| `hippo projects` | Projects with open counts and the last checkpoint |
| `hippo config [key] [value]` | Show or change config |
| `hippo doctor` | Health check, token usage, undo rate |

`hippo buy milk tomorrow` works as a dump too. Use `hippo d` when the dump starts with a command word like "today" or "done".

## Development

```bash
npm test                 # core tests (vitest) + native C++ tests
npm run typecheck
npm run wasm             # rebuild the C++ ranker as WebAssembly (needs wasi-sdk)
```

Layout:

```
packages/core/   @hippo/core: Brain facade, agents, store, providers, ranker, nudges, mirror
packages/cli/    the hippo command, macOS notifications, launchd, terminal greeting
native/ranker/   C++ ranker (BM25 + recency + urgency + project), C API, tests, wasm build
```

**Rebuilding the WebAssembly ranker on a Mac.** Download the `arm64-macos` tarball from the [wasi-sdk releases](https://github.com/WebAssembly/wasi-sdk/releases), then run `make -C native/ranker wasm WASI_SDK=/path/to/wasi-sdk-25.0-arm64-macos`. A prebuilt `hippo_ranker.wasm` is already included, and if it is ever missing Hippo falls back to the TypeScript ranker. `hippo doctor` tells you which engine is running.

**Adding a provider.** Implement `LlmProvider` in `packages/core/src/llm/` (one method, `generateJson`), then add it to `factory.ts`.

**Where to look first:** `packages/core/src/brain.ts` is the whole API, and `agents/actions.ts` is the validate-apply-undo path that every write goes through.

## Data

Everything lives in `~/.hippo` (override with `HIPPO_HOME`):

- `hippo.db` holds SQLite with every dump, item, checkpoint, action log entry and model call.
- `config.json` is yours to edit. It is created with mode 600 because it can hold keys.
- `status.txt` is the cached greeting.
- `mirror/` is the default markdown mirror.
- `logs/tick.log` is the background job's output.

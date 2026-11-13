# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Build/test/typecheck/wasm scripts are in `package.json`. The non-obvious invocations:

```bash
npm test -w @hippo/core -- rank              # one test file
npm test -w @hippo/core -- -t "quiet hours"  # one test by name
make -C native/ranker test                   # C++ tests only
```

`npm link -w hippo-cli` puts `hippo` on PATH. `hippo doctor` is the fastest way to see resolved config, which model provider loaded, which ranker engine is live, and recent token usage.

Rebuilding the wasm ranker needs wasi-sdk — the Makefile header documents the exact invocation. The prebuilt `packages/core/assets/hippo_ranker.wasm` is committed on purpose.

Useful env vars: `HIPPO_HOME` (data dir, default `~/.hippo`), `HIPPO_PROVIDER`, `HIPPO_RANKER=ts` (force the TypeScript ranker).

## Architecture

Three layers, each replaceable without touching the others. Two invariants hold them apart:

- **`@hippo/core` is platform-neutral — no `node:` imports outside `src/node/`.** All filesystem/env/driver wiring (`openBrain()`, paths, `node:sqlite`, key resolution, wasm loading, mirror sink) lives in that one subtree so a web or Tauri surface can swap it.
- **The CLI bundles to a single `dist/hippo.mjs` + wasm** (esbuild), because launchd must run it by absolute path with no `node_modules`. Anything macOS-specific — notifications, launchd, the zsh greeting — stays in `packages/cli`, never in core.

### Brain is the only API

`packages/core/src/brain.ts` is the entire public surface. The CLI calls nothing else, and a future web/Tauri surface is meant to call the same methods. Add features as Brain methods, not CLI logic.

`Brain` takes its dependencies injected (`store`, `config`, `provider`, `ranker`, `clock`, `sinks`) — never reads the filesystem, env, or `Date.now()` directly. Time always comes from the injected `Clock`, which is why tests can use `FakeClock`.

### The action-plan pattern (the core invariant)

Every write goes through `packages/core/src/agents/actions.ts`:

1. An agent (model or offline) proposes `FilerAction[]` validated by zod (`agents/schemas.ts`).
2. `resolveFilerActions()` checks each action against the database — unknown ids, unparseable or implausible dates, projectless checkpoints get **dropped with a warning, never thrown**.
3. `applyActions()` runs the resolved actions in one transaction, writing an `actions` audit row per change with its `before` state, all under one `batch` string (`capture:<id>` or `cmd:<name>:<ts>:<rand>`).
4. `undoLast()` reverses the most recent batch with active rows.

Nothing a model returns may touch SQLite except through this path. New write operations need a `ResolvedAction` variant with a matching undo case, or `undo` silently stops being correct.

### Graceful degradation is structural, not a fallback hack

- A dump is persisted to `captures` *before* any model call, so it is never lost. Model failure → `fileOffline()` (rule-based, `agents/filer-offline.ts`); failure after that → the capture is marked with an error and retried by later `tick`s for up to 2 days.
- If `resolveFilerActions` yields nothing, `capture()` keeps the raw text as a note rather than dropping it.
- Every agent has an offline twin emitting the same shape: `filer.ts`/`filer-offline.ts`, `planner.ts` (`planWithModel`/`planOffline`), `recall.ts`. The offline path therefore gets the same validation and undo semantics.
- The C++ wasm ranker falls back to `TsRanker` if the `.wasm` is missing or fails to load.

### Agents

`agents/{filer,planner,recall}.ts` each hold a system prompt, a prompt builder, and a `*WithModel` call. Prompts never ask the model to do date math — `time.ts#calendarForPrompt` injects a two-week calendar and models emit local `"YYYY-MM-DDTHH:MM"` strings (date-only means end of day). Model output for the planner and recall passes through `normalizePlan`/`normalizeRecall`, which drop task ids and time blocks that do not check out against the real day shape.

The filer prompt is fed only the *ranked* top-25 open tasks and top-15 notes plus anything referenced by `#id`, not the whole database.

### Providers

`llm/provider.ts` defines one interface — `generateJson<T>({schema, tier, ...})` — implemented with plain `fetch` (no SDKs) in `anthropic.ts`, `gemini.ts`, `openai.ts` (OpenAI-compatible, also covers Ollama). Shared helpers there do JSON-fence tolerant parsing and a validate-and-retry loop (`validated()`, two attempts, second one carries the zod issues back as a correction). Tiers are `fast` (filer) and `smart` (planner, recall).

To add a provider: implement `LlmProvider`, then wire it into `llm/factory.ts`. `createProvider` returns `{provider: null, reason}` rather than throwing — the reason surfaces in `hippo doctor` and after offline filing.

Keys resolve in order: config `apiKey` → env var → `apiKeyCommand` stdout (`src/node/index.ts`). The command form exists because launchd jobs see no shell env, so the macOS Keychain is the only route that works for `hippo tick`.

### Store and schema

`store/store.ts` is the only module that writes SQL. It accepts any `SqlDb` with the `node:sqlite`/`better-sqlite3` shape so the driver can be swapped (and a server port could reimplement just this class). All timestamps are epoch ms INTEGER. `tx()` nests by joining the outer transaction.

Schema changes mean bumping `SCHEMA_VERSION` and adding a numbered step to `MIGRATIONS` in `store/schema.ts`; `Store` applies pending steps on construction.

### Ranker parity

`native/ranker/src/ranker.cpp` (C++ → wasm) and `rank/ranker.ts` (`TsRanker`) implement the **same** BM25 + recency + urgency + project formula, and `rank/tokenize.ts` must match the C++ tokenizer byte for byte (lowercase ASCII only, non-ASCII kept as-is so Turkish letters survive, single ASCII chars and stopwords dropped). A randomized parity test in `test/rank.test.ts` runs both engines and compares. Change one side, change the other.

`rank/wasm-ranker.ts` stubs every WASI import rather than shipping a WASI runtime, so the loader is identical in Node, browser, and Tauri. Re-read `memory.buffer` after any `hr_alloc` — growth detaches old views.

### Nudges and tick

`nudge/policy.ts#planNudges` is a pure function of `(tasks, now, history)`. Nothing is pre-scheduled, so editing a due date or snoozing just takes effect on the next tick. It returns three lists with different persistence meanings: `send` and `skip` get recorded in `nudges` (never reconsidered), `held` (quiet hours or over the daily cap) is deliberately **not** recorded so the next tick re-evaluates it. Steps scheduled before the task existed are ignored, only the latest pending ladder step fires, and a passed deadline stops nudging (the brief handles overdue instead).

`Brain.tick()` is what launchd runs: retry pending captures, generate and notify the morning brief once per local day, then nudges.

### Sinks: mirror and status

Writes do not reach the filesystem directly. `Brain.refresh()` pushes to optional sinks after every change and **never throws** — a mirror failure must not fail a capture. `mirror/markdown.ts#renderMirror` returns a `Map<relative path, content>` regenerated wholesale (`Tasks.md`, `Ideas.md`, `Projects/<slug>.md`, `Daily/<date>.md`); the Node sink writes only changed files so Obsidian does not see churn. The mirror is one-way — the database is the source of truth and edits to the files are overwritten.

### Config

`config.ts` holds the zod schema plus `DEFAULT_CONFIG`; user JSON at `~/.hippo/config.json` is deep-merged over defaults and validated, so the file only needs changed keys. `resolveConfig` also eagerly parses every `HH:MM` and duration string so a typo fails loudly instead of silently breaking nudges. `hippo config <key> <value>` writes through `setDotted` and validates before writing; the file is chmod 600 because it can hold keys.

## Conventions

- ESM throughout (`"type": "module"`), NodeNext resolution — **relative imports must carry the `.js` extension**.
- `strict` plus `noUncheckedIndexedAccess`: indexed access needs `!` or a guard.
- Comment style here explains *why* a constraint exists (the invariant), not what the line does. Match that.
- Tests pin `TZ=America/Los_Angeles` (`test/setup.ts`) and use `T0` = Wed Nov 4 2026 14:56 local. Use `makeBrain()`, `FakeClock`, `FakeProvider` (scripted responses or scripted `Error`s) from `test/helpers.ts`; `memoryStore()` gives an in-memory SQLite Store.
- Vitest runs with `pool: 'forks'` because `node:sqlite` is used.

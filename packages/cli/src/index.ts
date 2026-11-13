#!/usr/bin/env node
import './silence.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  DAY, fmtWhen, getDotted, localDateKey, parseSnooze, resolveConfig, setDotted, type Brain,
} from '@hippo/core';
import {
  openBrain, paths as hippoPaths, readUserConfig, writeIfChanged, writeUserConfig,
} from '@hippo/core/node';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  addGreeting, greetingSnippet, installAgent, isMac, notify, plist, plistPath, removeGreeting, shellRc, uninstallAgent,
} from './mac.js';
import { renderBrief, renderCapture, renderTasks, renderWhere, statusText } from './render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const VERSION = '0.1.0';

function wasmPath(): string {
  const candidates = [join(HERE, 'hippo_ranker.wasm'), join(HERE, '..', '..', 'core', 'assets', 'hippo_ranker.wasm')];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

async function brain(): Promise<Brain> {
  const p = hippoPaths();
  const { brain: b } = await openBrain({
    wasmPath: wasmPath(),
    sinks: { status: (s) => writeIfChanged(p.status, statusText(s)) },
  });
  return b;
}

/** Spinner on stderr while a model call runs, only on a real terminal. */
async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) return fn();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(() => process.stderr.write(`\r${pc.dim(`${frames[i++ % frames.length]} ${label}`)}`), 80);
  try {
    return await fn();
  } finally {
    clearInterval(t);
    process.stderr.write('\r\x1b[2K');
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function promptDump(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(pc.dim('  Dump everything. Empty line to file it, Ctrl-C to cancel.'));
  const lines: string[] = [];
  try {
    for (;;) {
      const line = await rl.question(pc.magenta(lines.length ? '  … ' : '  › '));
      if (!line.trim()) break;
      lines.push(line);
    }
  } finally {
    rl.close();
  }
  return lines.join('\n');
}

async function dump(textParts: string[]): Promise<void> {
  let text = textParts.join(' ').trim();
  if (!text && !process.stdin.isTTY) {
    text = (await readStdin()).trim();
    if (!text) {
      console.log(pc.dim('  Nothing to file. Try: hippo d "whatever is on your mind"'));
      return;
    }
  }
  if (!text) text = (await promptDump()).trim();
  if (!text) return;
  const b = await brain();
  const r = await withSpinner('filing…', () => b.capture(text, process.stdin.isTTY ? 'cli' : 'stdin'));
  console.log(renderCapture(r, b.now()));
}

function maskKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(maskKeys);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) =>
      [k, /apikey$/i.test(k) && typeof v === 'string' ? `${v.slice(0, 6)}…` : maskKeys(v)]));
  }
  return obj;
}

const program = new Command();
program
  .name('hippo')
  .description('A terminal-first second brain for ADHD brains.')
  .version(VERSION)
  .argument('[text...]', 'brain dump text (same as hippo d)')
  .action(async (text: string[]) => {
    // Bare `hippo` (or piped stdin) is a brain dump; unknown words are too.
    await dump(text);
  });

program.command('d').alias('dump').description('brain dump: messy text in, filed tasks/notes/ideas out')
  .argument('[text...]').action(dump);

program.command('today').description("today's brief: top 3, first steps, a plan")
  .option('-f, --fresh', 'regenerate even if today already has one')
  .action(async (o: { fresh?: boolean }) => {
    const b = await brain();
    const brief = await withSpinner('planning…', () => b.today({ fresh: o.fresh }));
    console.log(renderBrief(brief, b.now()));
  });

program.command('where').description('where did I leave off? (default: last project touched)')
  .argument('[project...]').action(async (q: string[]) => {
    const b = await brain();
    const r = await withSpinner('remembering…', () => b.where(q.join(' ')));
    console.log(renderWhere(r, b.now()));
  });

program.command('park').description('save where you are: hippo park "signalos: did X, next: Y"')
  .argument('<text...>').option('-p, --project <name>', 'project (instead of a "name:" prefix)')
  .action(async (text: string[], o: { project?: string }) => {
    const b = await brain();
    const applied = b.park(text.join(' '), o.project);
    const a = applied.find((x) => x.kind === 'checkpoint');
    console.log(`  ${pc.green('+')} parked ${pc.cyan(a?.project ?? '')}: ${a?.title ?? ''}`);
  });

program.command('tasks').alias('ls').description('open tasks by when they are due').action(async () => {
  const b = await brain();
  console.log(renderTasks(b.tasks(), b.now(), (id) => b.projectSlug(id)));
});

program.command('done').description('complete a task by id (#12) or words').argument('<ref...>')
  .action(async (ref: string[]) => {
    const b = await brain();
    const r = b.done(ref.join(' '));
    if (r.status === 'done') console.log(`  ${pc.green('✓')} ${r.item.title} ${pc.dim(`#${r.item.id}`)}`);
    else if (r.status === 'ambiguous') {
      console.log('  Which one?');
      for (const t of r.candidates) console.log(`    ${pc.dim(`#${t.id}`)} ${t.title}   ${pc.dim(`hippo done ${t.id}`)}`);
    } else {
      console.log(pc.yellow('  No open task matches that.'));
      process.exitCode = 1;
    }
  });

program.command('snooze').description('quiet a task until later: 30m, 2h, 3d, tomorrow, tonight, 2026-11-10T09:00')
  .argument('<id>').argument('<until>').action(async (id: string, until: string) => {
    const b = await brain();
    const ms = parseSnooze(until, b.now());
    if (ms === null || ms <= b.now()) throw new Error(`Cannot read "${until}" as a future time.`);
    const it = b.snooze(Number(id.replace('#', '')), ms);
    console.log(`  ${pc.blue('z')} ${it.title} ${pc.dim(`snoozed until ${fmtWhen(ms, b.now())}`)}`);
  });

program.command('undo').description('reverse everything the last dump or command did').action(async () => {
  const b = await brain();
  const r = b.undo();
  if (!r.batch) return console.log(pc.dim('  Nothing to undo.'));
  for (const line of r.reverted) console.log(`  ${pc.yellow('↶')} ${line}`);
});

program.command('search').description('ranked search across everything').argument('<words...>')
  .action(async (w: string[]) => {
    const b = await brain();
    const hits = b.search(w.join(' '));
    if (!hits.length) return console.log(pc.dim('  No matches.'));
    for (const h of hits) {
      const it = h.item;
      const p = b.projectSlug(it.projectId);
      const state = it.status === 'done' ? pc.dim(' (done)') : '';
      console.log(`  ${pc.dim(`#${it.id}`.padEnd(5))} ${pc.dim(it.kind.padEnd(5))} ${it.title}${state} ${p ? pc.cyan(p) : ''}`);
    }
  });

program.command('projects').description('projects, open tasks, last checkpoint').action(async () => {
  const b = await brain();
  const rows = b.projects();
  if (!rows.length) return console.log(pc.dim('  No projects yet.'));
  for (const r of rows) {
    const cp = r.lastCheckpoint ? pc.dim(` · ${r.lastCheckpoint.nextStep ? `next: ${r.lastCheckpoint.nextStep}` : r.lastCheckpoint.summary}`) : '';
    console.log(`  ${pc.cyan(r.project.slug.padEnd(18))} ${String(r.open).padStart(2)} open  ${pc.dim(fmtWhen(r.project.lastTouchedAt, b.now()))}${cp}`);
  }
});

program.command('status').description('the two-line terminal greeting').action(async () => {
  const b = await brain();
  process.stdout.write(statusText(b.status()));
});

program.command('tick').description('background job: retry dumps, morning brief, nudges (run by launchd)')
  .option('--dry-run', 'print notifications instead of sending them')
  .action(async (o: { dryRun?: boolean }) => {
    const b = await brain();
    const send = o.dryRun
      ? async (n: { title: string; subtitle?: string; body: string }) => { console.log(`[would notify] ${n.title}: ${n.body}`); return true; }
      : notify;
    const r = await b.tick(send);
    const stamp = new Date(b.now()).toISOString();
    console.log(`${stamp} tick: ${r.sent.length} sent, ${r.held.length} held, ${r.skipped.length} skipped${r.briefGenerated ? ', brief generated' : ''}${r.processed ? `, ${r.processed} dumps retried` : ''}`);
  });

program.command('setup-mac').description('install the background job and the terminal greeting')
  .option('--interval <minutes>', 'how often the background job runs', '10')
  .option('--dry-run', 'show what would be installed')
  .option('--uninstall', 'remove the background job and greeting')
  .action(async (o: { interval: string; dryRun?: boolean; uninstall?: boolean }) => {
    const p = hippoPaths();
    const rc = shellRc();
    if (o.uninstall) {
      console.log(uninstallAgent() ? '  removed background job' : pc.dim('  no background job installed'));
      console.log(removeGreeting(rc) ? `  removed greeting from ${rc}` : pc.dim(`  no greeting in ${rc}`));
      return;
    }
    const content = plist({ node: process.execPath, script: SCRIPT, home: p.home, intervalSec: Math.max(60, Number(o.interval) * 60) });
    if (o.dryRun || !isMac) {
      if (!isMac) console.log(pc.yellow('  Not on macOS: showing what would be installed.\n'));
      console.log(pc.bold(`  ${plistPath()}`));
      console.log(content);
      console.log(pc.bold(`  appended to ${rc}`));
      console.log(greetingSnippet(p.status));
      return;
    }
    installAgent(content, p.home);
    console.log(`  ${pc.green('✓')} background job installed (every ${o.interval} min) at ${plistPath()}`);
    console.log(addGreeting(rc, p.status) ? `  ${pc.green('✓')} greeting added to ${rc}` : pc.dim(`  greeting already in ${rc}`));
    const b = await brain();
    b.refresh();
    console.log(pc.dim('  Open a new terminal to see it. Test a notification with: hippo tick'));
  });

program.command('config').description('show config, or get/set a key: hippo config provider gemini')
  .argument('[key]').argument('[value]').action(async (key?: string, value?: string) => {
    const p = hippoPaths();
    const user = readUserConfig(p);
    if (!key) {
      console.log(pc.dim(`  ${p.config}`));
      console.log(JSON.stringify(maskKeys(resolveConfig(user)), null, 2));
      return;
    }
    if (value === undefined) {
      console.log(JSON.stringify(maskKeys(getDotted(resolveConfig(user), key)), null, 2) ?? 'undefined');
      return;
    }
    let parsed: unknown = value;
    try {
      parsed = JSON.parse(value);
    } catch { /* plain string */ }
    const next = setDotted(user, key, parsed);
    resolveConfig(next); // validate before writing
    writeUserConfig(p, next);
    console.log(`  ${pc.green('✓')} ${key} = ${JSON.stringify(maskKeys({ [key.split('.').at(-1)!]: parsed })).slice(1, -1).split(':').slice(1).join(':')}`);
  });

program.command('doctor').description('check config, model key, database, ranker, background job').action(async () => {
  const p = hippoPaths();
  const ok = (s: string) => console.log(`  ${pc.green('✓')} ${s}`);
  const warn = (s: string) => console.log(`  ${pc.yellow('!')} ${s}`);
  const b = await brain();
  ok(`home ${p.home}`);
  ok(`database ${p.db} · ${Object.entries(b.store.counts()).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}`);
  if (b.provider) ok(`model provider ${b.provider.name} · fast ${b.provider.modelFor('fast')} · smart ${b.provider.modelFor('smart')}`);
  else warn(`no model provider: ${b.providerReason}. Filing works offline, just less cleverly.`);
  ok(`ranker engine: ${b.ranker.engine === 'wasm' ? 'C++ (WebAssembly)' : 'TypeScript fallback'}`);
  const mirror = b.config.mirrorDir === undefined ? join(p.home, 'mirror') : b.config.mirrorDir;
  mirror ? ok(`markdown mirror ${mirror}`) : warn('markdown mirror disabled');
  if (isMac) existsSync(plistPath()) ? ok(`background job ${plistPath()}`) : warn('background job not installed: run hippo setup-mac');
  const last = b.store.getMeta('last_tick');
  last ? ok(`last tick ${fmtWhen(Number(last), b.now())}`) : warn('background job has never run');
  const since = b.now() - 30 * DAY;
  const usage = b.store.llmUsage(since);
  if (usage.length) {
    for (const u of usage) ok(`last 30 days ${u.model}: ${u.calls} call${u.calls === 1 ? "" : "s"}, ${u.inputTokens} in / ${u.outputTokens} out tokens${u.failures ? `, ${u.failures} failed` : ''}`);
  }
  const undo = b.store.undoStats(since);
  if (undo.batches) ok(`undo rate ${Math.round((100 * undo.undone) / undo.batches)}% of ${undo.batches} dumps (target under 20%)`);
  const today = b.store.getBrief(localDateKey(b.now()));
  if (today) ok(`today's brief generated (${today.source})`);
  if (existsSync(p.status)) ok(`greeting cache ${p.status}`);
  const rc = shellRc();
  if (existsSync(rc) && !readFileSync(rc, 'utf8').includes('>>> hippo >>>')) warn(`greeting not in ${rc}: run hippo setup-mac`);
});

// `hippo some words` without a subcommand is a dump; make sure commander does
// not treat a typo'd command as an error.
program.showSuggestionAfterError(false);

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(pc.red(`  ${(e as Error).message}`));
  process.exit(1);
});

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Notification } from '@hippo/core';

// macOS integration: notifications, the launchd background job, and the
// terminal greeting. Everything platform-specific lives here, not in core.

export const LABEL = 'com.hippo.tick';
export const isMac = process.platform === 'darwin';

function which(cmd: string): string | null {
  try {
    return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function notify(n: Notification): Promise<boolean> {
  if (!isMac) {
    process.stdout.write(`[notify] ${n.title}${n.subtitle ? ` · ${n.subtitle}` : ''}: ${n.body}\n`);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const tn = which('terminal-notifier');
    const done = (err: Error | null) => resolve(!err);
    if (tn) {
      const args = ['-title', n.title, '-message', n.body, '-group', `hippo-${Date.now()}`];
      if (n.subtitle) args.push('-subtitle', n.subtitle);
      execFile(tn, args, done);
    } else {
      const script = `display notification "${esc(n.body)}" with title "${esc(n.title)}"${n.subtitle ? ` subtitle "${esc(n.subtitle)}"` : ''}`;
      execFile('/usr/bin/osascript', ['-e', script], done);
    }
  });
}

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist(opts: { node: string; script: string; home: string; intervalSec: number }): string {
  const path = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(opts.node)}</string>
    <string>${x(opts.script)}</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key><integer>${opts.intervalSec}</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HIPPO_HOME</key><string>${x(opts.home)}</string>
    <key>PATH</key><string>${x(path)}</string>
  </dict>
  <key>StandardOutPath</key><string>${x(join(opts.home, 'logs', 'tick.log'))}</string>
  <key>StandardErrorPath</key><string>${x(join(opts.home, 'logs', 'tick.log'))}</string>
</dict>
</plist>
`;
}

const MARK_START = '# >>> hippo >>>';
const MARK_END = '# <<< hippo <<<';

export function shellRc(): string {
  const shell = process.env.SHELL ?? '';
  if (shell.endsWith('bash')) return join(homedir(), isMac ? '.bash_profile' : '.bashrc');
  return join(homedir(), '.zshrc');
}

export function greetingSnippet(statusFile: string): string {
  return `${MARK_START}\n[ -f "${statusFile}" ] && cat "${statusFile}"\n${MARK_END}\n`;
}

export function addGreeting(rc: string, statusFile: string): boolean {
  const current = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
  if (current.includes(MARK_START)) return false;
  writeFileSync(rc, `${current}${current.endsWith('\n') || !current ? '' : '\n'}\n${greetingSnippet(statusFile)}`);
  return true;
}

export function removeGreeting(rc: string): boolean {
  if (!existsSync(rc)) return false;
  const current = readFileSync(rc, 'utf8');
  const re = new RegExp(`\\n?${MARK_START}[\\s\\S]*?${MARK_END}\\n?`, 'g');
  if (!re.test(current)) return false;
  writeFileSync(rc, current.replace(re, '\n'));
  return true;
}

function launchctl(args: string[]): boolean {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function installAgent(content: string, home: string): void {
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  const file = plistPath();
  const domain = `gui/${userInfo().uid}`;
  launchctl(['bootout', domain, file]); // fine if it was not loaded
  writeFileSync(file, content);
  if (!launchctl(['bootstrap', domain, file]) && !launchctl(['load', '-w', file])) {
    throw new Error(`launchctl could not load ${file}`);
  }
}

export function uninstallAgent(): boolean {
  const file = plistPath();
  if (!existsSync(file)) return false;
  launchctl(['bootout', `gui/${userInfo().uid}`, file]) || launchctl(['unload', file]);
  rmSync(file);
  return true;
}

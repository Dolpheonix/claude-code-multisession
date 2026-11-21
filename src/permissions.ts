import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PermissionRequestInfo, SessionStore } from './sessionStore';

/**
 * Permission prompts via Claude Code hooks (documented API, unlike transcripts).
 *
 * Claude Code POSTs the hook payload to a local URL (`type: "http"` hook). One VS Code window owns
 * the port; it answers immediately with `{}` (no decision, so Claude shows its normal prompt) and
 * appends the event to a shared file in the extension's global storage. Every window tails that
 * file, so all windows see prompts. If the owner closes, another window takes the port over.
 *
 * Hooks used:
 *  - PermissionRequest: fires the moment Claude is about to ask. Has tool_name/tool_input.
 *  - Notification (matcher permission_prompt): ~6 s into an unanswered prompt. Fallback signal.
 * Whether a prompt was answered comes from the transcript (see SessionStore.waitingFor).
 */

export const HOOK_PATH = '/claude-multisession/hook';
const RETRY_MS = 15_000;
const POLL_MS = 700;
const MAX_FILE_BYTES = 512 * 1024;
const KEEP_LINES = 500;

interface StoredEvent {
  sessionId: string;
  since: number;
  tool?: string;
  summary: string;
}

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}${HOOK_PATH}`;
}

export class PermissionEvents implements vscode.Disposable {
  private server: http.Server | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private offset = 0;
  private remainder = '';
  private port = 0;
  private loggedBusy = false;

  constructor(
    private readonly file: string,
    private readonly store: SessionStore,
    private readonly log: vscode.OutputChannel,
  ) {}

  start(port: number): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.port = port;
    this.listen();
    this.readNew();
    this.pollTimer = setInterval(() => this.readNew(), POLL_MS);
  }

  /** Port setting changed: give up the old port and try the new one. */
  restart(port: number): void {
    this.closeServer();
    this.port = port;
    this.loggedBusy = false;
    this.listen();
  }

  private listen(): void {
    const server = http.createServer((req, res) => this.handle(req, res));
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        if (!this.loggedBusy) {
          this.log.appendLine(`[hook] port ${this.port} in use (another VS Code window receives hook events); retrying`);
          this.loggedBusy = true;
        }
      } else {
        this.log.appendLine(`[hook] server error: ${e.message}`);
      }
      this.retryTimer = setTimeout(() => this.listen(), RETRY_MS);
    });
    server.listen(this.port, '127.0.0.1', () => {
      this.server = server;
      this.log.appendLine(`[hook] listening on ${hookUrl(this.port)}`);
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== HOOK_PATH) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
      }
    });
    req.on('end', () => {
      // Answer first: Claude Code waits for this response before showing its prompt.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      const ev = toStoredEvent(body);
      if (ev) {
        this.log.appendLine(`[hook] ${ev.sessionId.slice(0, 8)} waiting: ${ev.summary}`);
        this.append(ev);
      }
    });
  }

  private append(ev: StoredEvent): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify(ev) + '\n');
      if (fs.statSync(this.file).size > MAX_FILE_BYTES) {
        const lines = fs.readFileSync(this.file, 'utf8').trimEnd().split('\n');
        fs.writeFileSync(this.file, lines.slice(-KEEP_LINES).join('\n') + '\n');
      }
    } catch (e) {
      this.log.appendLine(`[hook] could not write ${this.file}: ${e}`);
    }
    this.readNew();
  }

  /** Tail the shared events file (written by whichever window owns the port). */
  private readNew(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // Trimmed by the owner: replay. Re-applying old events is harmless (newest prompt wins).
      this.offset = 0;
      this.remainder = '';
    }
    if (size === this.offset) {
      return;
    }
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const lines = (this.remainder + buf.toString('utf8')).split('\n');
      this.remainder = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as StoredEvent;
          const info: PermissionRequestInfo = { since: ev.since, tool: ev.tool, summary: ev.summary };
          this.store.applyPermission(ev.sessionId, info);
        } catch {
          /* partial or foreign line */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private closeServer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.server?.close();
    this.server = undefined;
  }

  dispose(): void {
    this.closeServer();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }
}

/** Hook payload → stored event, or undefined for anything we don't track. */
function toStoredEvent(body: string): StoredEvent | undefined {
  let p: any;
  try {
    p = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof p?.session_id !== 'string') {
    return undefined;
  }
  if (p.hook_event_name === 'PermissionRequest' && typeof p.tool_name === 'string') {
    return { sessionId: p.session_id, since: Date.now(), tool: p.tool_name, summary: summarize(p.tool_name, p.tool_input) };
  }
  if (p.hook_event_name === 'Notification' && p.notification_type === 'permission_prompt') {
    const msg = typeof p.message === 'string' && p.message ? p.message : 'Permission needed';
    return { sessionId: p.session_id, since: Date.now(), summary: msg };
  }
  return undefined;
}

/** "Bash: npm test", "Edit: treeViews.ts", "WebFetch: https://…" */
function summarize(tool: string, input: any): string {
  const clip = (s: string) => (s.length > 80 ? s.slice(0, 79) + '…' : s);
  const pathLike = input?.file_path ?? input?.notebook_path ?? input?.path;
  let detail: string | undefined;
  if (typeof input?.command === 'string') {
    detail = input.command.split('\n')[0];
  } else if (typeof pathLike === 'string') {
    detail = path.basename(pathLike);
  } else if (typeof input?.url === 'string') {
    detail = input.url;
  } else if (typeof input?.pattern === 'string') {
    detail = input.pattern;
  }
  return detail ? `${tool}: ${clip(detail)}` : tool;
}

// ---------------------------------------------------------------- hook install / uninstall

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

function isOurHandler(h: any): boolean {
  return h?.type === 'http' && typeof h.url === 'string' && h.url.includes(HOOK_PATH);
}

/** Remove our handlers (and groups/events left empty) from a settings object in place. */
function stripOurHooks(settings: any): void {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') {
    return;
  }
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) {
      continue;
    }
    hooks[event] = hooks[event]
      .map((g: any) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurHandler(h)) } : g))
      .filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (hooks[event].length === 0) {
      delete hooks[event];
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
}

function readSettings(): any | undefined {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not parse ${SETTINGS_FILE}: ${e}. Edit it by hand instead.`);
    return undefined;
  }
}

function writeSettings(settings: any): void {
  if (fs.existsSync(SETTINGS_FILE)) {
    fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE + '.multisession-backup');
  } else {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

export function isHookInstalled(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return Object.values(s.hooks ?? {}).some(
      (groups: any) => Array.isArray(groups) && groups.some((g: any) => g?.hooks?.some?.(isOurHandler)),
    );
  } catch {
    return false;
  }
}

export async function installHook(port: number, log: vscode.OutputChannel): Promise<void> {
  const settings = readSettings();
  if (!settings) {
    return;
  }
  // Short timeout and continue-on-failure: if no window is listening, Claude Code just shows its prompt.
  const handler = { type: 'http', url: hookUrl(port), timeout: 2, onFailure: 'continue' };
  const added = {
    PermissionRequest: [{ matcher: '*', hooks: [handler] }],
    Notification: [{ matcher: 'permission_prompt', hooks: [handler] }],
  };
  const choice = await vscode.window.showWarningMessage(
    `Add permission-prompt hooks to ${SETTINGS_FILE}?`,
    {
      modal: true,
      detail:
        'Claude Code will POST permission prompts to this extension so it can show which sessions are waiting. ' +
        'The extension never answers a prompt. A backup is saved as settings.json.multisession-backup.\n\n' +
        JSON.stringify({ hooks: added }, null, 2),
    },
    'Install',
  );
  if (choice !== 'Install') {
    return;
  }
  stripOurHooks(settings);
  settings.hooks ??= {};
  for (const [event, groups] of Object.entries(added)) {
    settings.hooks[event] = [...(Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []), ...groups];
  }
  writeSettings(settings);
  log.appendLine(`[hook] installed in ${SETTINGS_FILE} -> ${hookUrl(port)}`);
  void vscode.window.showInformationMessage('Permission hooks installed. New Claude Code prompts will show up in Claude Sessions.');
}

export async function uninstallHook(log: vscode.OutputChannel): Promise<void> {
  const settings = readSettings();
  if (!settings) {
    return;
  }
  if (!isHookInstalled()) {
    void vscode.window.showInformationMessage('No Claude Multi-Session hooks found in ~/.claude/settings.json.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Remove Claude Multi-Session hooks from ${SETTINGS_FILE}?`,
    { modal: true, detail: 'Only hooks pointing at this extension are removed. A backup is saved first.' },
    'Remove',
  );
  if (choice !== 'Remove') {
    return;
  }
  stripOurHooks(settings);
  writeSettings(settings);
  log.appendLine(`[hook] removed from ${SETTINGS_FILE}`);
}

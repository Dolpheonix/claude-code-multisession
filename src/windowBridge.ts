import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { fileKey } from './sessionStore';

/**
 * Lets one VS Code window ask another to open a Claude Code session.
 *
 * The extension API cannot list or message other windows, but this extension runs in each of them
 * and they share the global storage folder:
 *  - windows/<id>.json   each window's workspace folders, refreshed every HEARTBEAT_MS
 *  - requests/<id>/*.json  "open this session" requests addressed to window <id>, polled by it
 * The requesting window then runs `vscode.openFolder` on the session's cwd with forceNewWindow,
 * which VS Code turns into focusing the window that already has that folder open.
 */

const HEARTBEAT_MS = 10_000;
const STALE_MS = 35_000;
const POLL_MS = 500;
const REQUEST_MAX_AGE_MS = 15_000;

interface WindowInfo {
  id: string;
  pid: number;
  folders: string[]; // fileKey()s of the workspace folders
  seen: number;
  focused: number; // last time this window had focus
}

interface OpenRequest {
  sessionId: string;
  cwd: string;
  ts: number;
}

export class WindowBridge implements vscode.Disposable {
  readonly id = crypto.randomUUID();
  private readonly windowsDir: string;
  private readonly requestsDir: string;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly subs: vscode.Disposable[] = [];
  private focused = 0;

  constructor(
    storageDir: string,
    private readonly log: vscode.OutputChannel,
    private readonly onRequest: (sessionId: string) => void,
  ) {
    this.windowsDir = path.join(storageDir, 'windows');
    this.requestsDir = path.join(storageDir, 'requests');
  }

  start(): void {
    fs.mkdirSync(this.windowsDir, { recursive: true });
    fs.mkdirSync(this.myRequestsDir, { recursive: true });
    this.focused = vscode.window.state.focused ? Date.now() : 0;
    this.writeInfo();
    this.cleanupStale();
    this.timers.push(
      setInterval(() => this.writeInfo(), HEARTBEAT_MS),
      setInterval(() => this.cleanupStale(), STALE_MS),
      setInterval(() => this.readRequests(), POLL_MS),
    );
    this.subs.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.writeInfo()),
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) {
          this.focused = Date.now();
          this.writeInfo();
        }
      }),
    );
  }

  /** Another live window with exactly this folder open (the most recently focused one), if any. */
  findWindowFor(cwd: string): WindowInfo | undefined {
    const key = fileKey(cwd);
    return this.liveWindows()
      .filter((w) => w.id !== this.id && w.folders.includes(key))
      .sort((a, b) => b.focused - a.focused)[0];
  }

  /** Ask `target` to open the session, then bring that window to the front. */
  async requestOpen(target: WindowInfo, sessionId: string, cwd: string): Promise<void> {
    const req: OpenRequest = { sessionId, cwd, ts: Date.now() };
    const dir = path.join(this.requestsDir, target.id);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(req));
    fs.renameSync(tmp, tmp.replace(/\.tmp$/, '.json')); // never let the target read a half-written file
    this.log.appendLine(`[bridge] asked window ${target.id.slice(0, 8)} (pid ${target.pid}) to open ${sessionId}`);
    try {
      // The folder is already open in `target`, so VS Code focuses that window instead of opening a new one.
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), { forceNewWindow: true });
    } catch (e) {
      this.log.appendLine(`[bridge] focusing the window failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private get myRequestsDir(): string {
    return path.join(this.requestsDir, this.id);
  }

  private get infoFile(): string {
    return path.join(this.windowsDir, `${this.id}.json`);
  }

  private writeInfo(): void {
    const info: WindowInfo = {
      id: this.id,
      pid: process.pid,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => fileKey(f.uri.fsPath)),
      seen: Date.now(),
      focused: this.focused,
    };
    try {
      fs.writeFileSync(this.infoFile, JSON.stringify(info));
    } catch (e) {
      this.log.appendLine(`[bridge] could not write window info: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private liveWindows(): WindowInfo[] {
    const now = Date.now();
    const out: WindowInfo[] = [];
    for (const name of safeReaddir(this.windowsDir)) {
      try {
        const w = JSON.parse(fs.readFileSync(path.join(this.windowsDir, name), 'utf8')) as WindowInfo;
        if (now - w.seen < STALE_MS) {
          out.push(w);
        }
      } catch {
        // half-written or removed meanwhile
      }
    }
    return out;
  }

  /** Remove info and request folders of windows that stopped heartbeating (crashed or killed). */
  private cleanupStale(): void {
    const live = new Set(this.liveWindows().map((w) => w.id));
    live.add(this.id);
    for (const name of safeReaddir(this.windowsDir)) {
      if (!live.has(path.basename(name, '.json'))) {
        fs.rmSync(path.join(this.windowsDir, name), { force: true });
      }
    }
    for (const name of safeReaddir(this.requestsDir)) {
      if (!live.has(name)) {
        fs.rmSync(path.join(this.requestsDir, name), { recursive: true, force: true });
      }
    }
  }

  private readRequests(): void {
    for (const name of safeReaddir(this.myRequestsDir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const file = path.join(this.myRequestsDir, name);
      let req: OpenRequest;
      try {
        req = JSON.parse(fs.readFileSync(file, 'utf8')) as OpenRequest;
      } catch {
        continue;
      } finally {
        fs.rmSync(file, { force: true });
      }
      const age = Date.now() - req.ts;
      if (age > REQUEST_MAX_AGE_MS) {
        this.log.appendLine(`[bridge] dropped stale request for ${req.sessionId} (${Math.round(age / 1000)} s old)`);
        continue;
      }
      this.log.appendLine(`[bridge] request from another window: open ${req.sessionId}`);
      this.onRequest(req.sessionId);
    }
  }

  dispose(): void {
    this.timers.forEach(clearInterval);
    this.subs.forEach((d) => d.dispose());
    fs.rmSync(this.infoFile, { force: true });
    fs.rmSync(this.myRequestsDir, { recursive: true, force: true });
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

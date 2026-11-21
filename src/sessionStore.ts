import * as path from 'path';
import * as vscode from 'vscode';
import { TranscriptEvent } from './parser';

export interface FileTouch {
  reads: number;
  edits: number;
  lastTs: number;
}

export interface Session {
  id: string;
  title?: string;
  /** Directory the session started in (native path). */
  cwd?: string;
  /** Whether `cwd` came from the main transcript (vs. a subagent transcript read first). */
  cwdFromMain?: boolean;
  transcriptPath?: string;
  firstTs: number;
  lastTs: number;
  /** key = normalized file key */
  files: Map<string, FileTouch>;
}

export interface FileInfo {
  key: string;
  /** Path as first seen (for display / opening). */
  displayPath: string;
  /** sessionId -> touch */
  touches: Map<string, FileTouch>;
}

export type ConflictLevel = 'none' | 'readWrite' | 'writeWrite';

export function conflictLevel(f: FileInfo): ConflictLevel {
  let editors = 0;
  for (const t of f.touches.values()) {
    if (t.edits > 0) {
      editors++;
    }
  }
  if (editors >= 2) {
    return 'writeWrite';
  }
  if (editors === 1 && f.touches.size >= 2) {
    return 'readWrite';
  }
  return 'none';
}

/**
 * Normalize file paths so the same file from different sessions maps to one key.
 * TODO: map git worktrees back to the main repo root (e.g. via `git rev-parse --show-toplevel`
 *       + path relative to it) so sessions in different worktrees are compared by repo-relative path.
 */
export function fileKey(p: string, cwd?: string): string {
  p = toNativePath(p);
  cwd = cwd === undefined ? undefined : toNativePath(cwd);
  let abs = path.isAbsolute(p) ? p : path.resolve(cwd ?? '', p);
  abs = path.normalize(abs);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    abs = abs.toLowerCase();
  }
  return abs;
}

/** On Windows, turn MSYS/Git-Bash style paths (`/c/Users/...`) into native ones (`c:\Users\...`). */
export function toNativePath(p: string): string {
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) {
      return `${m[1]}:${(m[2] ?? '/').replaceAll('/', '\\')}`;
    }
  }
  return p;
}

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  readonly files = new Map<string, FileInfo>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private changeTimer: NodeJS.Timeout | undefined;

  clear(): void {
    this.sessions.clear();
    this.files.clear();
    this.fireChanged();
  }

  apply(events: TranscriptEvent[], transcriptPath: string): void {
    if (events.length === 0) {
      return;
    }
    for (const ev of events) {
      const s = this.getSession(ev.sessionId);
      // Sidechain (subagent) transcripts share the parent's sessionId; prefer the main file.
      const isMain = path.basename(transcriptPath, '.jsonl') === ev.sessionId;
      if (!s.transcriptPath || isMain) {
        s.transcriptPath = transcriptPath;
      }

      switch (ev.kind) {
        case 'title':
          s.title = ev.title;
          break;
        case 'meta':
          this.applyMeta(s, ev, isMain);
          break;
        case 'file':
          this.applyFile(s, ev);
          break;
      }
    }
    this.fireChanged();
  }

  conflicts(): FileInfo[] {
    return [...this.files.values()]
      .filter((f) => conflictLevel(f) !== 'none')
      .sort((a, b) => (conflictLevel(a) === 'writeWrite' ? -1 : 1) - (conflictLevel(b) === 'writeWrite' ? -1 : 1));
  }

  private applyMeta(s: Session, ev: Extract<TranscriptEvent, { kind: 'meta' }>, isMain: boolean): void {
    // The session's cwd is where it started (first cwd of the main transcript): that's the
    // project Claude Code files it under. Later lines may carry a shell cwd after `cd`.
    if (ev.cwd && (!s.cwd || (isMain && !s.cwdFromMain))) {
      s.cwd = toNativePath(ev.cwd);
      s.cwdFromMain = isMain;
    }
    if (ev.timestamp) {
      this.touchTime(s, ev.timestamp);
    }
  }

  private applyFile(s: Session, ev: Extract<TranscriptEvent, { kind: 'file' }>): void {
    this.touchTime(s, ev.timestamp);
    const key = fileKey(ev.filePath, ev.cwd ?? s.cwd);
    const st = s.files.get(key) ?? { reads: 0, edits: 0, lastTs: 0 };
    if (ev.access === 'edit') {
      st.edits++;
    } else {
      st.reads++;
    }
    st.lastTs = Math.max(st.lastTs, ev.timestamp);
    s.files.set(key, st);

    let f = this.files.get(key);
    if (!f) {
      f = { key, displayPath: ev.filePath, touches: new Map() };
      this.files.set(key, f);
    }
    f.touches.set(s.id, st);
  }

  private getSession(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, firstTs: Infinity, lastTs: 0, files: new Map() };
      this.sessions.set(id, s);
    }
    return s;
  }

  private touchTime(s: Session, ts: number): void {
    s.firstTs = Math.min(s.firstTs, ts);
    s.lastTs = Math.max(s.lastTs, ts);
  }

  /** Debounced so bursts of transcript lines produce one UI update. */
  private fireChanged(): void {
    if (this.changeTimer) {
      return;
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this._onDidChange.fire();
    }, 250);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

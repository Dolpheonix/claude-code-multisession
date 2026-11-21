import * as os from 'os';
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
  /** Latest permission prompt reported by the hook (see {@link SessionStore.waitingFor}). */
  permission?: PermissionRequestInfo;
  /** Unfinished tool calls: tool_use id -> tool name. */
  openToolUses: Map<string, string>;
  /** tool name -> time of its latest result (approved+ran, failed, or denied). */
  lastResultByTool: Map<string, number>;
  lastResultTs: number;
  lastPromptTs: number;
  /** Skills / slash commands used: name -> count, last use, and whether Claude invoked it via the Skill tool. */
  skills: Map<string, SkillUse>;
}

export interface SkillUse {
  count: number;
  lastTs: number;
  /** Seen as a `Skill` tool call (so it is a real skill, not a built-in command like /clear). */
  viaTool: boolean;
}

export interface PermissionRequestInfo {
  /** When the prompt was reported (ms). */
  since: number;
  /** Tool asking for permission; absent for a bare permission_prompt notification. */
  tool?: string;
  /** Short human-readable description, e.g. "Bash: npm test". */
  summary: string;
}

/** A permission prompt never answered (session closed meanwhile) stops showing after this long. */
const PERMISSION_MAX_AGE_MS = 2 * 3600_000;

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

/**
 * Claude Code's own temp area (`<tmp>/claude/<id>/<session>/scratchpad/...`): throwaway scripts and
 * outputs that never get merged anywhere, so they're not tracked as session files.
 * Matched by location under the OS temp dir, and by the `claude/…/scratchpad` shape in case the
 * temp dir differs (e.g. a custom TMPDIR for Claude Code).
 */
const CLAUDE_TEMP_PREFIX = fileKey(path.join(os.tmpdir(), 'claude')) + path.sep;
const SCRATCHPAD_SHAPE = /[\\/]claude[\\/](?:[^\\/]+[\\/])*scratchpad(?:[\\/]|$)/;

export function isClaudeTempFile(key: string): boolean {
  return key.startsWith(CLAUDE_TEMP_PREFIX) || SCRATCHPAD_SHAPE.test(key);
}

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  readonly files = new Map<string, FileInfo>();

  /**
   * Sessions the user switched off in the sidebar: kept in the Sessions view (unchecked) but left
   * out of the graph and conflict detection, e.g. finished work that no longer matters for merging.
   */
  readonly excluded = new Set<string>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private changeTimer: NodeJS.Timeout | undefined;

  isIncluded(sessionId: string): boolean {
    return !this.excluded.has(sessionId);
  }

  setIncluded(sessionIds: Iterable<string>, included: boolean): void {
    let changed = false;
    for (const id of sessionIds) {
      if (included === this.excluded.has(id)) {
        if (included) {
          this.excluded.delete(id);
        } else {
          this.excluded.add(id);
        }
        changed = true;
      }
    }
    if (changed) {
      this.fireChanged();
    }
  }

  /** Sessions archived in Claude Code (see claudeArchive.ts); hidden unless `showArchived` is on. */
  readonly archived = new Set<string>();

  setArchived(ids: Set<string>): void {
    if (ids.size === this.archived.size && [...ids].every((id) => this.archived.has(id))) {
      return;
    }
    this.archived.clear();
    ids.forEach((id) => this.archived.add(id));
    this.fireChanged();
  }

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
        case 'toolUse':
          s.openToolUses.set(ev.toolUseId, ev.tool);
          break;
        case 'toolResult': {
          const tool = s.openToolUses.get(ev.toolUseId);
          s.openToolUses.delete(ev.toolUseId);
          if (tool) {
            s.lastResultByTool.set(tool, Math.max(s.lastResultByTool.get(tool) ?? 0, ev.timestamp));
          }
          s.lastResultTs = Math.max(s.lastResultTs, ev.timestamp);
          break;
        }
        case 'prompt':
          s.lastPromptTs = Math.max(s.lastPromptTs, ev.timestamp);
          break;
        case 'skill': {
          const u = s.skills.get(ev.name) ?? { count: 0, lastTs: 0, viaTool: false };
          u.count++;
          u.viaTool ||= ev.via === 'tool';
          u.lastTs = Math.max(u.lastTs, ev.timestamp);
          s.skills.set(ev.name, u);
          break;
        }
      }
    }
    this.fireChanged();
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
    if (isClaudeTempFile(key)) {
      return;
    }
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

  /**
   * Record a permission prompt reported by the hook. A `Notification` (no tool, ~6 s after the
   * prompt) for a prompt already known is ignored so the original time and tool are kept.
   */
  applyPermission(sessionId: string, info: PermissionRequestInfo): void {
    if (Date.now() - info.since > PERMISSION_MAX_AGE_MS) {
      return;
    }
    const s = this.getSession(sessionId);
    const current = this.waitingFor(s);
    if (current && (!info.tool || current.since >= info.since)) {
      return;
    }
    s.permission = info;
    this.fireChanged();
  }

  /**
   * The prompt the session is still waiting on, if any. Derived (not stored) so hook events and
   * transcript lines can arrive in any order: a prompt is answered once a result for its tool
   * (or, without a tool, any result) or a new user message appears after it.
   */
  waitingFor(s: Session): PermissionRequestInfo | undefined {
    const p = s.permission;
    if (!p || Date.now() - p.since > PERMISSION_MAX_AGE_MS || s.lastPromptTs > p.since) {
      return undefined;
    }
    const answeredAt = p.tool ? (s.lastResultByTool.get(p.tool) ?? 0) : s.lastResultTs;
    return answeredAt > p.since ? undefined : p;
  }

  private getSession(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        firstTs: Infinity,
        lastTs: 0,
        files: new Map(),
        openToolUses: new Map(),
        lastResultByTool: new Map(),
        lastResultTs: 0,
        lastPromptTs: 0,
        skills: new Map(),
      };
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

import * as path from 'path';
import * as vscode from 'vscode';
import { conflictLevel, ConflictLevel, fileKey, Session, SessionStore } from './sessionStore';

export interface GraphSession {
  id: string;
  label: string;
  cwd?: string;
  branch?: string;
  active: boolean;
  lastTs: number;
}

export interface GraphFile {
  key: string;
  path: string;
  label: string;
  conflict: ConflictLevel;
}

export interface GraphEdge {
  session: string;
  file: string;
  reads: number;
  edits: number;
  lastTs: number;
}

export interface GraphState {
  sessions: GraphSession[];
  files: GraphFile[];
  edges: GraphEdge[];
}

function cfg() {
  return vscode.workspace.getConfiguration('claudeMultisession');
}

export function isActive(s: Session): boolean {
  return Date.now() - s.lastTs < cfg().get<number>('activeMinutes', 10) * 60_000;
}

export function sessionLabel(s: Session): string {
  return s.title ?? `${s.cwd ? path.basename(s.cwd) : 'session'} · ${s.id.slice(0, 8)}`;
}

/**
 * Whether the session's cwd is an open workspace folder.
 * `exact` = cwd must be the folder itself (what Claude Code can resume in this window);
 * otherwise subfolders count too.
 */
export function isInWorkspace(s: Session, exact = false): boolean {
  if (!s.cwd) {
    return false;
  }
  const k = fileKey(s.cwd);
  return (vscode.workspace.workspaceFolders ?? [])
    .map((f) => fileKey(f.uri.fsPath))
    .some((f) => k === f || (!exact && k.startsWith(f + path.sep)));
}

/** Sessions that pass the scope + lookback filters, most recent first. */
export function visibleSessions(store: SessionStore): Session[] {
  const scope = cfg().get<string>('scope', 'all');
  const cutoff = Date.now() - cfg().get<number>('lookbackHours', 24) * 3600_000;

  return [...store.sessions.values()]
    .filter((s) => s.lastTs >= cutoff)
    .filter((s) => scope !== 'workspace' || isInWorkspace(s))
    .sort((a, b) => b.lastTs - a.lastTs);
}

export function buildGraphState(store: SessionStore): GraphState {
  const sessions = visibleSessions(store);
  const ids = new Set(sessions.map((s) => s.id));
  const files: GraphFile[] = [];
  const edges: GraphEdge[] = [];

  for (const f of store.files.values()) {
    const touching = [...f.touches.entries()].filter(([sid]) => ids.has(sid));
    if (touching.length === 0) {
      continue;
    }
    // Recompute conflict using only visible sessions.
    const visible = { ...f, touches: new Map(touching) };
    files.push({
      key: f.key,
      path: f.displayPath,
      label: path.basename(f.displayPath),
      conflict: conflictLevel(visible),
    });
    for (const [sid, t] of touching) {
      edges.push({ session: sid, file: f.key, reads: t.reads, edits: t.edits, lastTs: t.lastTs });
    }
  }

  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      label: sessionLabel(s),
      cwd: s.cwd,
      branch: s.gitBranch,
      active: isActive(s),
      lastTs: s.lastTs,
    })),
    files,
    edges,
  };
}

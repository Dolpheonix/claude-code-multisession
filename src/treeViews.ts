import * as path from 'path';
import * as vscode from 'vscode';
import { conflictLevel, FileInfo, fileKey, Session, SessionStore } from './sessionStore';
import { isActive, isInWorkspace, sessionLabel, visibleSessions } from './viewModel';

export type Node =
  | { type: 'workspace'; key: string; cwd?: string; sessions: Session[] }
  | { type: 'session'; session: Session }
  | { type: 'file'; session: Session; key: string; display: string; reads: number; edits: number; shared: boolean };

/** How often to re-render anyway so "3m ago" / active status stay current. */
const PERIODIC_REFRESH_MS = 30_000;

/**
 * Fires a tree refresh only when what the tree shows actually changed.
 *
 * Active transcripts are appended to constantly; re-rendering the whole tree on every line
 * disposes each item's command registration while the user is clicking it, so clicks get lost.
 */
abstract class GatedTreeProvider<T> implements vscode.TreeDataProvider<T>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChange];
  private lastSig = '';

  constructor(protected readonly store: SessionStore) {
    this.disposables.push(store.onDidChange(() => this.refreshIfChanged()));
    const t = setInterval(() => this.refresh(), PERIODIC_REFRESH_MS);
    this.disposables.push({ dispose: () => clearInterval(t) });
  }

  /** Compact string of everything the tree renders (except relative times). */
  protected abstract signature(): string;
  abstract getChildren(node?: T): T[];
  abstract getTreeItem(node: T): vscode.TreeItem;

  refresh(): void {
    this.lastSig = this.signature();
    this._onDidChange.fire();
  }

  private refreshIfChanged(): void {
    if (this.signature() !== this.lastSig) {
      this.refresh();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Group key for sessions without a known cwd. */
const NO_CWD = '\u0000';

function groupByWorkspace(): boolean {
  return vscode.workspace.getConfiguration('claudeMultisession').get<boolean>('groupByWorkspace', true);
}

/** (Workspace →) sessions → files each one touched. */
export class SessionsTreeProvider extends GatedTreeProvider<Node> {
  protected signature(): string {
    return (groupByWorkspace() ? 'g' : 'f') + visibleSessions(this.store)
      .map((s) => {
        let reads = 0;
        let edits = 0;
        for (const t of s.files.values()) {
          reads += t.reads;
          edits += t.edits;
        }
        return [s.id, sessionLabel(s), s.cwd, isActive(s), s.files.size, reads, edits].join('\u0001');
      })
      .join('\u0002');
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const sessions = visibleSessions(this.store);
      return groupByWorkspace()
        ? this.workspaceGroups(sessions)
        : sessions.map((session) => ({ type: 'session', session }));
    }
    if (node.type === 'workspace') {
      return node.sessions.map((session) => ({ type: 'session', session }));
    }
    if (node.type !== 'session') {
      return [];
    }
    return [...node.session.files.entries()]
      .sort((a, b) => b[1].lastTs - a[1].lastTs)
      .map(([key, t]) => {
        const f = this.store.files.get(key);
        return {
          type: 'file',
          session: node.session,
          key,
          display: f?.displayPath ?? key,
          reads: t.reads,
          edits: t.edits,
          shared: (f?.touches.size ?? 0) > 1,
        };
      });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'workspace':
        return this.workspaceItem(node);
      case 'session':
        return this.sessionItem(node);
      case 'file':
        return this.fileItem(node);
    }
  }

  /**
   * Groups sessions by the directory they started in (their cwd).
   * Groups for this window's workspace folders come first, then by most recent activity;
   * sessions keep their most-recent-first order inside a group.
   */
  private workspaceGroups(sessions: Session[]): Node[] {
    const groups = new Map<string, Extract<Node, { type: 'workspace' }>>();
    for (const s of sessions) {
      const key = s.cwd ? fileKey(s.cwd) : NO_CWD;
      let g = groups.get(key);
      if (!g) {
        g = { type: 'workspace', key, cwd: s.cwd, sessions: [] };
        groups.set(key, g);
      }
      g.sessions.push(s);
    }
    const current = (g: Extract<Node, { type: 'workspace' }>) => (isInWorkspace(g.sessions[0], true) ? 0 : 1);
    return [...groups.values()].sort(
      (a, b) => current(a) - current(b) || b.sessions[0].lastTs - a.sessions[0].lastTs,
    );
  }

  private workspaceItem(node: Extract<Node, { type: 'workspace' }>): vscode.TreeItem {
    const label = node.cwd ? path.basename(node.cwd) || node.cwd : '(unknown folder)';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `w:${node.key}`;
    const active = node.sessions.filter(isActive).length;
    const current = isInWorkspace(node.sessions[0], true);
    const n = node.sessions.length;
    item.description = `${n} session${n === 1 ? '' : 's'}${active ? ` · ${active} active` : ''}`;
    item.tooltip = new vscode.MarkdownString(
      `**${label}**${current ? ' (this window)' : ''}\n\n\`${node.cwd ?? '?'}\``,
    );
    item.iconPath = new vscode.ThemeIcon(
      current ? 'root-folder' : 'folder',
      active ? new vscode.ThemeColor('charts.green') : undefined,
    );
    item.contextValue = current ? 'workspace.current' : 'workspace';
    return item;
  }

  private sessionItem(node: Extract<Node, { type: 'session' }>): vscode.TreeItem {
    const s = node.session;
    const item = new vscode.TreeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.Collapsed);
    // Stable id keeps selection/expansion across refreshes.
    item.id = `s:${s.id}`;
    const active = isActive(s);
    // Untitled sessions already show the cwd folder in their label; grouped sessions show it in the group.
    const folder = !groupByWorkspace() && s.title && s.cwd ? `${path.basename(s.cwd)} · ` : '';
    item.description = `${folder}${active ? 'active' : 'idle'} · ${s.files.size} files · ${timeAgo(s.lastTs)}`;
    item.tooltip = new vscode.MarkdownString(
      `**${sessionLabel(s)}**\n\n- id: \`${s.id}\`\n- cwd: \`${s.cwd ?? '?'}\`\n- branch: \`${s.gitBranch ?? '?'}\``,
    );
    item.iconPath = new vscode.ThemeIcon(
      active ? 'circle-filled' : 'circle-outline',
      active ? new vscode.ThemeColor('charts.green') : undefined,
    );
    // Sessions of this window's workspace can be resumed in Claude Code; others open the raw transcript.
    const resumable = isInWorkspace(s, true);
    item.contextValue = resumable ? 'session.workspace' : 'session';
    item.command = {
      command: 'claudeMultisession.openSession',
      title: resumable ? 'Open in Claude Code' : 'Open transcript',
      arguments: [node],
    };
    return item;
  }

  private fileItem(node: Extract<Node, { type: 'file' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(node.display));
    item.id = `f:${node.session.id}|${node.key}`;
    item.description = `${node.edits ? `✎${node.edits} ` : ''}${node.reads ? `👁${node.reads}` : ''}`;
    item.tooltip = node.display;
    item.resourceUri = vscode.Uri.file(node.display);
    item.iconPath = node.shared
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'))
      : vscode.ThemeIcon.File;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.display)] };
    return item;
  }
}

/** Files touched by 2+ sessions. */
export class ConflictsTreeProvider extends GatedTreeProvider<FileInfo> {
  protected signature(): string {
    return this.getChildren()
      .map((f) => [f.key, conflictLevel(f), ...[...f.touches].map(([sid, t]) => `${sid}:${t.edits > 0}`)].join('\u0001'))
      .join('\u0002');
  }

  getChildren(node?: FileInfo): FileInfo[] {
    if (node) {
      return [];
    }
    const visible = new Set(visibleSessions(this.store).map((s) => s.id));
    return this.store
      .conflicts()
      .filter((f) => [...f.touches.keys()].filter((id) => visible.has(id)).length >= 2);
  }

  getTreeItem(f: FileInfo): vscode.TreeItem {
    const level = conflictLevel(f);
    const item = new vscode.TreeItem(path.basename(f.displayPath));
    item.id = `c:${f.key}`;
    const names = [...f.touches.entries()].map(([sid, t]) => {
      const s = this.store.sessions.get(sid);
      return `${s ? sessionLabel(s) : sid.slice(0, 8)} (${t.edits ? 'edit' : 'read'})`;
    });
    item.description = `${f.touches.size} sessions`;
    item.tooltip = `${f.displayPath}\n\n${names.join('\n')}`;
    item.iconPath = new vscode.ThemeIcon(
      level === 'writeWrite' ? 'error' : 'warning',
      new vscode.ThemeColor(level === 'writeWrite' ? 'charts.red' : 'charts.orange'),
    );
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(f.displayPath)] };
    return item;
  }
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  if (s < 3600) {
    return `${Math.round(s / 60)}m ago`;
  }
  return `${Math.round(s / 3600)}h ago`;
}

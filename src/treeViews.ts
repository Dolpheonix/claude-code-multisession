import * as path from 'path';
import * as vscode from 'vscode';
import { conflictLevel, FileInfo, Session, SessionStore } from './sessionStore';
import { isActive, isInWorkspace, sessionLabel, visibleSessions } from './viewModel';

export type Node =
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

/** Sessions → files each one touched. */
export class SessionsTreeProvider extends GatedTreeProvider<Node> {
  protected signature(): string {
    return visibleSessions(this.store)
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
      return visibleSessions(this.store).map((session) => ({ type: 'session', session }));
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
    return node.type === 'session' ? this.sessionItem(node) : this.fileItem(node);
  }

  private sessionItem(node: Extract<Node, { type: 'session' }>): vscode.TreeItem {
    const s = node.session;
    const item = new vscode.TreeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.Collapsed);
    // Stable id keeps selection/expansion across refreshes.
    item.id = `s:${s.id}`;
    const active = isActive(s);
    // Untitled sessions already show the cwd folder in their label.
    const folder = s.title && s.cwd ? `${path.basename(s.cwd)} · ` : '';
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

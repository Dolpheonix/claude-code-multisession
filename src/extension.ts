import * as vscode from 'vscode';
import { GraphPanel } from './graphPanel';
import { Session, SessionStore } from './sessionStore';
import { TranscriptWatcher } from './transcriptWatcher';
import { openInClaudeCode } from './claudeCode';
import { ConflictsTreeProvider, Node, SessionsTreeProvider } from './treeViews';
import { isInWorkspace } from './viewModel';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Claude Multi-Session');
  const store = new SessionStore();
  const watcher = new TranscriptWatcher(store, log);

  const sessionsTree = new SessionsTreeProvider(store);
  const conflictsTree = new ConflictsTreeProvider(store);
  const conflictsView = vscode.window.createTreeView('claudeMultisession.conflicts', { treeDataProvider: conflictsTree });

  // Badge on the activity bar icon = number of shared files.
  let lastBadge = -1;
  store.onDidChange(() => {
    const n = conflictsTree.getChildren().length;
    if (n !== lastBadge) {
      lastBadge = n;
      conflictsView.badge = n ? { value: n, tooltip: `${n} files touched by multiple sessions` } : undefined;
    }
  });

  context.subscriptions.push(
    log,
    store,
    watcher,
    sessionsTree,
    conflictsTree,
    conflictsView,
    vscode.window.registerTreeDataProvider('claudeMultisession.sessions', sessionsTree),
    vscode.commands.registerCommand('claudeMultisession.openGraph', () => GraphPanel.show(context, store)),
    vscode.commands.registerCommand('claudeMultisession.refresh', () => watcher.rescan()),
    // Tree click: resume in Claude Code if the session belongs to this window's workspace, else show the transcript.
    // Accepts a tree node or a session id (from the graph webview).
    vscode.commands.registerCommand('claudeMultisession.openSession', (arg?: Node | string) => {
      let s: Session | undefined;
      if (typeof arg === 'string') {
        s = store.sessions.get(arg);
      } else if (arg?.type === 'session') {
        s = arg.session;
      }
      if (!s) {
        log.appendLine(`[click] ignored: no session for ${typeof arg === 'string' ? arg : arg?.type}`);
        return;
      }
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const resumable = isInWorkspace(s, true);
      log.appendLine(`[click] session=${s.id} cwd=${s.cwd ?? '?'} workspace=[${folders.join(', ')}] resumable=${resumable}`);
      if (resumable) {
        void openInClaudeCode(s.id, log);
      } else if (s.transcriptPath) {
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(s.transcriptPath));
      }
    }),
    vscode.commands.registerCommand('claudeMultisession.openInClaude', (node?: Node) => {
      if (node?.type === 'session') {
        void openInClaudeCode(node.session.id, log);
      }
    }),
    vscode.commands.registerCommand('claudeMultisession.openTranscript', (node?: Node) => {
      const p = node?.type === 'session' ? node.session.transcriptPath : undefined;
      if (p) {
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p));
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      sessionsTree.refresh();
      conflictsTree.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeMultisession.projectsDir')) {
        watcher.rescan();
      } else if (e.affectsConfiguration('claudeMultisession')) {
        sessionsTree.refresh();
        conflictsTree.refresh();
      }
    }),
  );

  watcher.start();
}

export function deactivate(): void {}

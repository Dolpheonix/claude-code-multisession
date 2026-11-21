import * as path from 'path';
import * as vscode from 'vscode';
import { openInClaudeCode } from './claudeCode';
import { GraphPanel } from './graphPanel';
import { installHook, isHookInstalled, PermissionEvents, uninstallHook } from './permissions';
import { clearRepoRootCache } from './repoRoot';
import { PermissionRequestInfo, Session, SessionStore } from './sessionStore';
import { TranscriptWatcher } from './transcriptWatcher';
import { ConflictsTreeProvider, Node, SessionsTreeProvider } from './treeViews';
import { isInWorkspace, sessionLabel, visibleSessions } from './viewModel';
import { WindowBridge } from './windowBridge';

const cfg = () => vscode.workspace.getConfiguration('claudeMultisession');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Claude Multi-Session');
  const store = new SessionStore();
  const watcher = new TranscriptWatcher(store, log);

  // Sessions switched off in the sidebar persist across restarts.
  const EXCLUDED_KEY = 'excludedSessions';
  store.setIncluded(context.globalState.get<string[]>(EXCLUDED_KEY, []), false);

  const sessionsTree = new SessionsTreeProvider(store);
  const conflictsTree = new ConflictsTreeProvider(store);
  const sessionsView = vscode.window.createTreeView('claudeMultisession.sessions', {
    treeDataProvider: sessionsTree,
    // A workspace checkbox should toggle exactly its sessions, not the file rows below them.
    manageCheckboxStateManually: true,
  });
  sessionsView.onDidChangeCheckboxState((e) => {
    for (const [node, state] of e.items) {
      const included = state === vscode.TreeItemCheckboxState.Checked;
      if (node.type === 'session') {
        store.setIncluded([node.session.id], included);
      } else if (node.type === 'workspace') {
        store.setIncluded(node.sessions.map((s) => s.id), included);
      }
    }
    void context.globalState.update(EXCLUDED_KEY, [...store.excluded]);
  });
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

  // Permission prompts (via Claude Code hooks): Sessions badge + a notification per new prompt.
  const hookPort = () => cfg().get<number>('hookPort', 47821);
  const permissions = new PermissionEvents(
    path.join(context.globalStorageUri.fsPath, 'permission-events.jsonl'),
    store,
    log,
  );
  permissions.start(hookPort());
  const activatedAt = Date.now();
  const notified = new Set<string>();
  const updateWaiting = () => {
    const waiting = visibleSessions(store)
      .map((s) => ({ s, p: store.waitingFor(s) }))
      .filter((x): x is { s: Session; p: PermissionRequestInfo } => x.p !== undefined);
    sessionsView.badge = waiting.length
      ? { value: waiting.length, tooltip: `${waiting.length} session(s) waiting for permission` }
      : undefined;
    for (const { s, p } of waiting) {
      const key = `${s.id}:${p.since}`;
      // Only prompts that appeared while this window was open (not replayed history), once each.
      if (notified.has(key) || p.since < activatedAt - 5_000 || !cfg().get<boolean>('notifyPermission', true)) {
        continue;
      }
      notified.add(key);
      // Keep it to one short line: session + tool. The full command is in the Sessions view tooltip.
      const label = clip(sessionLabel(s), 40);
      const what = p.tool ? `wants to run ${p.tool}` : 'is waiting for permission';
      void vscode.window
        .showInformationMessage(`🔔 ${label} ${what}`, 'Open Session')
        .then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand('claudeMultisession.openSession', s.id);
          }
        });
    }
  };
  store.onDidChange(updateWaiting);
  if (!isHookInstalled()) {
    log.appendLine('[hook] permission hooks not installed (run "Claude Multi-Session: Install Permission Hooks")');
  }

  // Sessions whose folder is open in another VS Code window are opened there.
  const bridge = new WindowBridge(context.globalStorageUri.fsPath, log, (id) => void openInClaudeCode(id, log));
  bridge.start();

  context.subscriptions.push(
    log,
    permissions,
    bridge,
    vscode.commands.registerCommand('claudeMultisession.installPermissionHook', () => installHook(hookPort(), log)),
    vscode.commands.registerCommand('claudeMultisession.uninstallPermissionHook', () => uninstallHook(log)),
    store,
    watcher,
    sessionsTree,
    conflictsTree,
    conflictsView,
    sessionsView,
    vscode.commands.registerCommand('claudeMultisession.openGraph', () => GraphPanel.show(context, store)),
    vscode.commands.registerCommand('claudeMultisession.refresh', () => {
      clearRepoRootCache(); // repos may have been created (git init) or removed since
      watcher.rescan();
    }),
    // Tree click: resume in Claude Code if the session belongs to this window's workspace, or in the window that
    // has its folder open; else show the transcript.
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
      const other = !resumable && s.cwd ? bridge.findWindowFor(s.cwd) : undefined;
      if (resumable) {
        void openInClaudeCode(s.id, log);
      } else if (other && s.cwd) {
        void bridge.requestOpen(other, s.id, s.cwd);
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
      if (e.affectsConfiguration('claudeMultisession.hookPort')) {
        permissions.restart(hookPort());
        if (isHookInstalled()) {
          void vscode.window.showWarningMessage(
            'The hook port changed. Run "Install Permission Hooks" again so Claude Code posts to the new port.',
          );
        }
      } else if (e.affectsConfiguration('claudeMultisession.projectsDir')) {
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

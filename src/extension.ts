import * as fs from 'fs';
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
import { claudeHome, createSkill, installSkillFolder, SKILL_NAME_RE, skillFolderDiffers } from './skills';
import { skillFolder, SkillNode, SkillsTreeProvider } from './skillsTree';

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
  const bridge = new WindowBridge(context.globalStorageUri.fsPath, log, (id, prompt) => void openInClaudeCode(id, log, prompt));

  /** Session from a tree node or a session id (graph webview, notifications). */
  const sessionOf = (arg?: Node | string): Session | undefined => {
    if (typeof arg === 'string') {
      return store.sessions.get(arg);
    }
    return arg?.type === 'session' ? arg.session : undefined;
  };
  /**
   * Resume in Claude Code: here if the session belongs to this window's workspace, else in the window
   * that has its folder open. Returns false if neither applies.
   */
  const resumeAnywhere = (s: Session, prompt?: string): boolean => {
    if (isInWorkspace(s, true)) {
      void openInClaudeCode(s.id, log, prompt);
      return true;
    }
    const other = s.cwd ? bridge.findWindowFor(s.cwd) : undefined;
    if (other && s.cwd) {
      void bridge.requestOpen(other, s.id, s.cwd, prompt);
      return true;
    }
    return false;
  };
  bridge.start();

  // Skills: scanned from disk, re-scanned when SKILL.md / command files change.
  const skillsTree = new SkillsTreeProvider(store);
  const skillsView = vscode.window.createTreeView('claudeMultisession.skills', { treeDataProvider: skillsTree });
  let rescanTimer: NodeJS.Timeout | undefined;
  const rescanSkillsSoon = () => {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => skillsTree.rescan(), 300);
  };
  const skillWatchers = [
    // Skill files, plus the settings that turn skills/plugins off (skillOverrides, enabledPlugins).
    new vscode.RelativePattern(vscode.Uri.file(claudeHome()), '{skills/**,commands/**,plugins/**/SKILL.md,settings.json}'),
    '**/.claude/{skills/**,commands/**,settings.json,settings.local.json}',
  ].map((pattern) => {
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    w.onDidCreate(rescanSkillsSoon);
    w.onDidChange(rescanSkillsSoon);
    w.onDidDelete(rescanSkillsSoon);
    return w;
  });

  context.subscriptions.push(
    log,
    permissions,
    bridge,
    skillsTree,
    skillsView,
    ...skillWatchers,
    { dispose: () => clearTimeout(rescanTimer) },
    vscode.commands.registerCommand('claudeMultisession.refreshSkills', () => skillsTree.rescan()),
    vscode.commands.registerCommand('claudeMultisession.newSkill', () => newSkill(skillsTree)),
    vscode.commands.registerCommand('claudeMultisession.revealSkill', (node?: SkillNode) => {
      if (node?.type === 'skill') {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skillFolder(node.skill)));
      }
    }),
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
      const s = sessionOf(arg);
      if (!s) {
        log.appendLine(`[click] ignored: no session for ${typeof arg === 'string' ? arg : arg?.type}`);
        return;
      }
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const resumable = isInWorkspace(s, true);
      log.appendLine(`[click] session=${s.id} cwd=${s.cwd ?? '?'} workspace=[${folders.join(', ')}] resumable=${resumable}`);
      if (!resumeAnywhere(s) && s.transcriptPath) {
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(s.transcriptPath));
      }
    }),
    // Resume the session with the wrap-up prompt (default "/wrap-up") in its input box.
    vscode.commands.registerCommand('claudeMultisession.wrapUp', async (arg?: Node | string) => {
      const s = sessionOf(arg);
      if (!s) {
        return;
      }
      const prompt = cfg().get<string>('wrapUpPrompt', '/wrap-up').trim() || '/wrap-up';
      if (prompt.startsWith('/wrap-up') && !fs.existsSync(path.join(claudeHome(), 'skills', 'wrap-up', 'SKILL.md'))) {
        void vscode.window
          .showInformationMessage('The /wrap-up skill is not installed in ~/.claude/skills.', 'Install Globally')
          .then((c) => c && vscode.commands.executeCommand('claudeMultisession.installWrapUpSkill'));
      }
      if (!resumeAnywhere(s, prompt)) {
        await vscode.env.clipboard.writeText(prompt);
        void vscode.window.showWarningMessage(
          `No VS Code window has ${s.cwd ?? 'this session\'s folder'} open. Open that folder, resume the session, and paste "${prompt}" (copied to the clipboard).`,
        );
      }
    }),
    vscode.commands.registerCommand('claudeMultisession.installWrapUpSkill', () =>
      installWrapUpSkill(path.join(context.extensionPath, '.claude', 'skills', 'wrap-up'), log, skillsTree),
    ),
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
      skillsTree.rescan();
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

/**
 * Installs the /wrap-up skill bundled with this extension (the repo's .claude/skills/wrap-up) as a
 * personal skill, so sessions in every folder can use it. Asks before overwriting a different copy.
 */
async function installWrapUpSkill(src: string, log: vscode.OutputChannel, tree: SkillsTreeProvider): Promise<void> {
  const destRoot = path.join(claudeHome(), 'skills');
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    void vscode.window.showErrorMessage(`Bundled skill not found: ${src}`);
    return;
  }
  if (skillFolderDiffers(src, destRoot)) {
    const ok = await vscode.window.showWarningMessage(
      `${path.join(destRoot, 'wrap-up')} already exists and differs from the extension's version. Overwrite it?`,
      { modal: true },
      'Overwrite',
    );
    if (!ok) {
      return;
    }
  }
  try {
    const { dest, result } = installSkillFolder(src, destRoot);
    log.appendLine(`[skills] wrap-up ${result}: ${dest}`);
    tree.rescan();
    const msg = {
      created: `Installed /wrap-up in ${dest}. Every Claude Code session can use it now.`,
      updated: `Updated /wrap-up in ${dest}.`,
      same: `/wrap-up in ${dest} is already up to date.`,
    }[result];
    void vscode.window.showInformationMessage(msg);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not install /wrap-up: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Ask where and what, create `<skills dir>/<name>/SKILL.md` from a template, and open it. */
async function newSkill(tree: SkillsTreeProvider): Promise<void> {
  const locations = [
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => ({
      label: `$(repo) Project: ${f.name}`,
      description: 'shared through the repo',
      dir: path.join(f.uri.fsPath, '.claude', 'skills'),
    })),
    { label: '$(account) Personal', description: 'all your projects', dir: path.join(claudeHome(), 'skills') },
  ];
  const where = await vscode.window.showQuickPick(locations, { title: 'New skill: where?' });
  if (!where) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'New skill: name',
    prompt: `Lowercase letters, digits and hyphens. Invoked as /<name>. Created in ${where.dir}`,
    validateInput: (v) => (SKILL_NAME_RE.test(v) ? undefined : 'Use lowercase letters, digits and hyphens (max 64).'),
  });
  if (!name) {
    return;
  }
  const description = await vscode.window.showInputBox({
    title: 'New skill: description',
    prompt: 'What it does and when Claude should use it (Claude decides from this text).',
  });
  if (description === undefined) {
    return;
  }
  try {
    const file = createSkill(where.dir, name, description || `TODO: describe when to use ${name}`);
    tree.rescan();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not create the skill: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function deactivate(): void {}

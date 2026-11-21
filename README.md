# Claude Code Multi-Session Monitor

Watches all your Claude Code sessions at once and draws which files each one reads and edits. Files that more than one session touches are highlighted, so you can see conflicts before they happen.

## How it works

Claude Code writes one transcript per session to `~/.claude/projects/<project>/<session-id>.jsonl`. The extension tails these files (with `fs.watch` plus a 5-second poll) and pulls out `Read` / `Edit` / `MultiEdit` / `Write` / `NotebookEdit` tool calls and their file paths.

Each session's **cwd** is the directory it started in: the first `cwd` of its main transcript. Later lines can carry a different cwd after the session `cd`s elsewhere, and those are ignored. Git-Bash style paths (`/c/Users/...`) are normalized to native Windows paths.

Files in Claude Code's own temp area (`<tmp>/claude/…`, including each session's `scratchpad/`) are ignored. They hold throwaway scripts and outputs that never get merged, so they would only add noise to the graph and the conflicts.

The transcript format is not a public API. All format knowledge lives in [src/parser.ts](src/parser.ts).

| File | Role |
| --- | --- |
| [src/parser.ts](src/parser.ts) | JSONL line → events (session meta, title, file access) |
| [src/transcriptWatcher.ts](src/transcriptWatcher.ts) | Incremental tailing of transcript files |
| [src/sessionStore.ts](src/sessionStore.ts) | Session ↔ file model, conflict detection, path normalization |
| [src/viewModel.ts](src/viewModel.ts) | Scope/lookback/workspace filtering, graph state for the webview |
| [src/treeViews.ts](src/treeViews.ts) | Sidebar: Sessions and Conflicts views |
| [src/graphPanel.ts](src/graphPanel.ts) + [media/graph.js](media/graph.js) | Cytoscape graph webview |
| [src/claudeCode.ts](src/claudeCode.ts) | Opening a session in the Claude Code extension |
| [src/repoRoot.ts](src/repoRoot.ts) | Finding (and caching) the git repo root of a file, for display paths |
| [src/permissions.ts](src/permissions.ts) | Permission-prompt hooks: local receiver, shared events file, hook install/uninstall |
| [src/windowBridge.ts](src/windowBridge.ts) | Asking another VS Code window to open a session |
| [src/skills.ts](src/skills.ts) + [src/skillsTree.ts](src/skillsTree.ts) | Finding skills / custom commands on disk; Skills view with usage counts |

## Features

- **Sessions view**: sessions grouped by workspace (the folder each session started in), each listing the files it touched (✎ edits, 👁 reads). Folders open in this window are listed first. Turn grouping off with `claudeMultisession.groupByWorkspace`.
  - Each session has a checkbox. Unchecking it leaves the session in this list but **excludes it from the graph and from conflict detection**. Use this for finished work that no longer matters when you check what merging the remaining branches will affect. A workspace group's checkbox toggles all of its sessions. The excluded set is kept across restarts.
- **Conflicts view**: files touched by 2+ included sessions, with a badge count on the activity bar
- **Skills view**: skills and custom commands on disk with usage counts (see [Skills](#skills))
- **Graph**: a left-to-right layout. Sessions are in the left column and files in the right, and each session's files are grouped next to it. Files shared by several sessions are placed between those sessions' groups.
  - session label: title, then the cwd folder
  - file label: path from the root of the git repo that contains it (the nearest folder with a `.git` directory or file, so worktrees count too), e.g. `my-repo/src/a.ts`. It looks the same in every window. Files outside any repo show the path from the session's cwd. Long paths are shortened from the left. The trees show the same folders next to each file name. Repo roots are cached; **Rescan Transcripts** clears the cache after a `git init`.
  - red file: written by 2+ sessions
  - orange file: written by one session, read by another
  - the **Conflicts** checkbox turns this red/orange highlighting off
  - solid arrows are edits, dashed lines are reads
  - hover to highlight a node's neighbors and see a tooltip (full cwd for sessions, full path for files)
  - filters: workspace dropdown (by session cwd), conflicts, show reads, shared files only, active sessions only. Filter choices are kept when the panel is reopened.
- **Open in Claude Code**: clicking a session in the tree or the graph resumes it in the Claude Code extension when the session's cwd is exactly a workspace folder of the current window. If another VS Code window has that folder open, the session opens in that window and VS Code switches to it. Other sessions open their raw transcript instead. Right-click a session for **Open in Claude Code** / **Open Transcript**.

### One branch per session: keeping project knowledge

If each branch gets its own session, a new session starts without what earlier sessions learned. The knowledge should travel the same way as the code:

- **Write it in CLAUDE.md on the branch.** Claude Code loads `CLAUDE.md` at the start of every session. A session updates it on its branch and commits it, so the knowledge reaches `main` with the merge, gets reviewed in the PR, and shows up as a git conflict if two branches disagree. Abandoned branches leave nothing behind.
- **Branch-only context** (why this change, what is left) belongs in commit messages and the PR description. Personal preferences belong in `~/.claude/CLAUDE.md`, not the repo.
- With git worktrees, Claude Code's automatic memory (`~/.claude/projects/<path>/memory/`) is separate for each worktree path. CLAUDE.md in the repo is not.

The extension supports this:

- **⚑ not wrapped up**: a session that edited files but none of the knowledge files (`claudeMultisession.knowledgeFiles`, default `CLAUDE.md`) gets this mark in the Sessions view. Knowledge files show a 📘 book icon. Only edits made through Claude's tools count.
- **Wrap Up Session** (right-click a session): resumes the session in Claude Code, here or in the window that has its folder open, with `claudeMultisession.wrapUpPrompt` (default `/wrap-up`) in its input box. Claude Code 2.1.x puts it in the input box without sending it. If no window has the folder open, the prompt is copied to the clipboard.
- **Conflicts**: a knowledge file edited by several sessions is marked `📘 knowledge`, since what those sessions recorded may conflict when their branches merge.

The [/wrap-up skill](.claude/skills/wrap-up/SKILL.md) is kept in this repo and ships with the extension. It sorts what the session learned into CLAUDE.md, branch-only notes, and personal preferences, then updates CLAUDE.md and asks before committing. It is set to `disable-model-invocation`, so it runs only when you type it.

Run **Claude Multi-Session: Install /wrap-up Skill Globally** to copy it to `~/.claude/skills/wrap-up/`, where sessions in every folder can use it. Run it again after the repo's copy changes: it reports "up to date" when nothing changed, and asks before overwriting a copy you edited. **Wrap Up Session** offers the install when the skill is missing.

The repo copy alone only loads for sessions started in this repo (or its subfolders). Claude Code reads `.claude/skills` from the start folder and its parents. Skills in subfolders load only after Claude touches a file there, or after `/add-dir`.

### Skills

The **Skills** view lists the skills and custom slash commands Claude Code can load, grouped by where they live:

| Group | Location | Editable |
| --- | --- | --- |
| Project · *folder* | `<workspace folder>/.claude/skills/<name>/SKILL.md` and `.claude/commands/**.md` | yes |
| Personal | `~/.claude/skills/<name>/SKILL.md` | yes |
| Custom commands | `~/.claude/commands/**.md` (the older single-file format; subfolders become `sub/name`) | yes |
| Plugins | `skills/<name>/SKILL.md` inside installed plugins under `~/.claude/plugins` | 🔒 overwritten by plugin updates |
| claude.ai (synced) | `~/.claude/skills/synced/…`: skills synced from your claude.ai account | 🔒 overwritten by sync |

- Each entry shows its frontmatter `description`. Click it to open the file, or right-click for **Reveal in File Explorer**.
- **Usage**: `3×` means the skill was used 3 times by **this workspace's sessions** (cwd in or under an open folder) within the `lookbackHours` window. That counts both Claude invoking it with the `Skill` tool and you typing `/name`. The tooltip lists the sessions and also gives the total across all workspaces. Namespaced uses such as `anthropic-skills:docx` count toward `docx` for plugin and synced skills.
- **Used, not on disk**: skills that Claude invoked in this workspace's sessions but that have no `SKILL.md` here, such as skills bundled with Claude Code itself. Other workspaces are left out, since their project skills are not listed here.
- **On/off state**: read from the same settings Claude Code uses, merged per open folder (user `~/.claude/settings.json` < project `.claude/settings.json` < local `.claude/settings.local.json`, key by key). Managed (enterprise) settings are not read.
  - `[off]` (greyed icon): a skill set to `"off"` in `skillOverrides`, or a plugin set to `false` in `enabledPlugins` (key `<plugin>@<marketplace>`, from the `cache/<marketplace>/<plugin>/<version>/` folder). A plugin whose manifest says `defaultEnabled: false` is also off unless `enabledPlugins` turns it on.
  - `[off in some folders]`: with several folders open, the skill is off for sessions in some of them. The tooltip names them.
  - `[name-only]` / `[user-invocable-only]`: other `skillOverrides` modes.
  - Project skills are checked only against their own folder's settings.
- **New Skill** (＋ in the view title) asks for a location (a project folder or Personal), a name (lowercase letters, digits, hyphens), and a description. It then creates `<name>/SKILL.md` from a template and opens it.
- The view rescans when files under those folders change; **Rescan Skills** forces it.

The view only displays this state. Change it in the settings files (or with `/plugin` for plugins); the view picks up the change.

### Permission prompts

Shows which sessions are waiting for you to approve a tool. This uses [Claude Code hooks](https://code.claude.com/docs/en/hooks), a documented interface, so run **Claude Multi-Session: Install Permission Hooks** once. After you confirm, it adds `http` hooks to `~/.claude/settings.json` and saves a backup as `settings.json.multisession-backup`:

- `PermissionRequest` (every tool): fires the moment Claude is about to ask.
- `Notification` with matcher `permission_prompt`: fires about 6 s into an unanswered prompt, as a fallback.

Both POST to `http://127.0.0.1:<claudeMultisession.hookPort>/claude-multisession/hook` with a 2 s timeout and `onFailure: "continue"`. The extension answers immediately with `{}` (no decision), so Claude Code always shows its normal prompt. If no VS Code window is listening, the request fails fast and the prompt appears as usual. **Uninstall Permission Hooks** removes only these entries.

A waiting session gets a 🔔 icon and the prompt summary (e.g. `Bash: npm test`) in the Sessions view, a count badge, a pulsing yellow ring in the graph, and a notification with **Open Session** (turn it off with `claudeMultisession.notifyPermission`). The prompt counts as answered once its tool's result appears in the transcript (approved and ran, failed, or denied) or the user sends a new message. Unanswered prompts stop showing after 2 hours.

Only one VS Code window can own the port. That window appends events to a file in the extension's global storage, and every window tails it. If the owner closes, another window takes the port over within 15 s.

Limitations: `PermissionRequest` has no tool-use id, so a prompt is matched to a later result of the same tool. Needs Claude Code 2.1.295+ for `onFailure`; the VS Code extension sends `permission_prompt` notifications from 2.1.233.

### Claude Code integration

Opening a session uses the Claude Code extension's internal `claude-vscode.editor.open` command, and falls back to its `vscode://anthropic.claude-code/open?session=<id>` URI handler. Neither is a documented API (they were found in Claude Code 2.1.x), so they may break with Claude Code updates. Every attempt is logged to the **Claude Multi-Session** output channel.

Claude Code files a session under the directory it started in, so only sessions whose cwd *equals* a workspace folder can be resumed from this window. A session started in a subfolder needs a window opened on that subfolder.

The extension API cannot see or message other windows, so the windows coordinate through the extension's global storage folder. Each window records its workspace folders in `windows/<id>.json` every 10 s. To hand a session over, a window writes a request to `requests/<target-id>/`, which the target polls, and then runs `vscode.openFolder` on the session's cwd (new-window mode). Because that folder is already open, VS Code focuses the existing window instead of opening another. If several windows have the folder open, the most recently focused one gets the session. Requests older than 15 s are dropped, and windows that stop updating their file (for example after a crash) are ignored after 35 s.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeMultisession.projectsDir` | `~/.claude/projects` | Transcript root |
| `claudeMultisession.lookbackHours` | `24` | Ignore sessions older than this |
| `claudeMultisession.activeMinutes` | `10` | Sessions with activity in this window are "active" |
| `claudeMultisession.groupByWorkspace` | `true` | Group the Sessions view by workspace (session cwd) |
| `claudeMultisession.hookPort` | `47821` | Local port for the permission hooks (re-run **Install Permission Hooks** after changing) |
| `claudeMultisession.notifyPermission` | `true` | Notify when a session starts waiting for a permission prompt |
| `claudeMultisession.knowledgeFiles` | `["CLAUDE.md"]` | Files where sessions record what they learned (file name or path suffix). Sessions that edited files but none of these are marked "not wrapped up" |
| `claudeMultisession.wrapUpPrompt` | `/wrap-up` | Prompt that **Wrap Up Session** puts in the Claude Code input box |
| `claudeMultisession.scope` | `all` | `workspace` limits the tree and graph to sessions whose cwd is in (or under) an open folder |

## Development

```sh
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host. Open the **Claude Sessions** icon in the activity bar, or run `Claude Multi-Session: Open Session Graph`.

- Changes under `media/` only need the graph panel to be reopened. Changes to `src/` or `package.json` need the debug session to be restarted.
- To test **Open in Claude Code**, open the folder a session started in inside the Development Host window. A session only counts as "current workspace" in the window that has its cwd open.

## Troubleshooting

- **The Claude Sessions icon is missing and the views appear under Explorer.** Some Claude Code versions use the proposed API `contribSecondarySidebar`. On VS Code builds that don't allow it, VS Code throws while registering view containers, and every extension's activity bar container falls back to Explorer (the log shows `View container '…' does not exist`). Update VS Code, or add `"enable-proposed-api": ["Anthropic.claude-code"]` to `argv.json` (**Preferences: Configure Runtime Arguments**). The bundled [.vscode/launch.json](.vscode/launch.json) already passes `--enable-proposed-api Anthropic.claude-code` to the Development Host.
- **Clicking a session does nothing.** Check the **Claude Multi-Session** output channel. Each click logs a `[click] … resumable=…` line (with the session cwd and the workspace folders it was compared against), followed by `[open]` lines.

## Roadmap

- Hook integration (`PreToolUse` / `PostToolUse` → local HTTP server) for real-time events through a documented interface, and to warn or block when another session is editing the same file
- Worktree-aware path mapping, so the same repo-relative file is matched across git worktrees
- Line-range overlap detection from `Edit.old_string`
- Timeline view

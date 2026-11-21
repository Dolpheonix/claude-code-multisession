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

## Features

- **Sessions view**: sessions grouped by workspace (the folder each session started in), each listing the files it touched (✎ edits, 👁 reads). Folders open in this window are listed first. Turn grouping off with `claudeMultisession.groupByWorkspace`.
  - Each session has a checkbox. Unchecking it leaves the session in this list but **excludes it from the graph and from conflict detection**. Use this for finished work that no longer matters when you check what merging the remaining branches will affect. A workspace group's checkbox toggles all of its sessions. The excluded set is kept across restarts.
- **Conflicts view**: files touched by 2+ included sessions, with a badge count on the activity bar
- **Graph**: a left-to-right layout. Sessions are in the left column and files in the right, and each session's files are grouped next to it. Files shared by several sessions are placed between those sessions' groups.
  - session label: title, then the cwd folder
  - file label: path from the root of the git repo that contains it (the nearest folder with a `.git` directory or file, so worktrees count too), e.g. `my-repo/src/a.ts`. It looks the same in every window. Files outside any repo show the path from the session's cwd. Long paths are shortened from the left. The trees show the same folders next to each file name. Repo roots are cached; **Rescan Transcripts** clears the cache after a `git init`.
  - red file: written by 2+ sessions
  - orange file: written by one session, read by another
  - the **Conflicts** checkbox turns this red/orange highlighting off
  - solid arrows are edits, dashed lines are reads
  - hover to highlight a node's neighbors and see a tooltip (full cwd for sessions, full path for files)
  - filters: workspace dropdown (by session cwd), conflicts, show reads, shared files only, active sessions only. Filter choices are kept when the panel is reopened.
- **Open in Claude Code**: clicking a session in the tree or the graph resumes it in the Claude Code extension when the session's cwd is exactly a workspace folder of the current window. Other sessions open their raw transcript instead. Right-click a session for **Open in Claude Code** / **Open Transcript**.

### Claude Code integration

Opening a session uses the Claude Code extension's internal `claude-vscode.editor.open` command, and falls back to its `vscode://anthropic.claude-code/open?session=<id>` URI handler. Neither is a documented API (they were found in Claude Code 2.1.x), so they may break with Claude Code updates. Every attempt is logged to the **Claude Multi-Session** output channel.

Claude Code files a session under the directory it started in, so only sessions whose cwd *equals* a workspace folder can be resumed from this window. A session started in a subfolder needs a window opened on that subfolder.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeMultisession.projectsDir` | `~/.claude/projects` | Transcript root |
| `claudeMultisession.lookbackHours` | `24` | Ignore sessions older than this |
| `claudeMultisession.activeMinutes` | `10` | Sessions with activity in this window are "active" |
| `claudeMultisession.groupByWorkspace` | `true` | Group the Sessions view by workspace (session cwd) |
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

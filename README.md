# Claude Code Multi-Session Monitor

Watches all your Claude Code sessions at once and draws which files each one reads and edits. Files that more than one session touches are highlighted, so you can see conflicts before they happen.

## How it works

Claude Code writes one transcript per session to `~/.claude/projects/<project>/<session-id>.jsonl`. The extension tails these files (with `fs.watch` plus a 5-second poll) and pulls out `Read` / `Edit` / `MultiEdit` / `Write` / `NotebookEdit` tool calls and their file paths.

The transcript format is not a public API. All format knowledge lives in [src/parser.ts](src/parser.ts).

| File | Role |
| --- | --- |
| [src/parser.ts](src/parser.ts) | JSONL line → events (session meta, title, file access) |
| [src/transcriptWatcher.ts](src/transcriptWatcher.ts) | Incremental tailing of transcript files |
| [src/sessionStore.ts](src/sessionStore.ts) | Session ↔ file model, conflict detection, path normalization |
| [src/viewModel.ts](src/viewModel.ts) | Scope/lookback filtering, graph state for the webview |
| [src/treeViews.ts](src/treeViews.ts) | Sidebar: Sessions and Conflicts views |
| [src/graphPanel.ts](src/graphPanel.ts) + [media/graph.js](media/graph.js) | Cytoscape graph webview |

## Features

- **Sessions view**: active/idle sessions, each listing the files it touched (✎ edits, 👁 reads)
- **Conflicts view**: files touched by 2+ sessions, with a badge count on the activity bar
- **Graph**: sessions are colored squares, files are circles
  - red: written by 2+ sessions
  - orange: written by one session, read by another
  - solid arrows are edits, dashed lines are reads
  - hover to highlight a node's neighbors; click a file to open it, or a session to open its transcript
  - filters: show reads, shared files only, active sessions only

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeMultisession.projectsDir` | `~/.claude/projects` | Transcript root |
| `claudeMultisession.lookbackHours` | `24` | Ignore sessions older than this |
| `claudeMultisession.activeMinutes` | `10` | Sessions with activity in this window are "active" |
| `claudeMultisession.scope` | `all` | `workspace` limits to sessions whose cwd is in an open folder |

## Development

```sh
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host. Open the **Claude Sessions** icon in the activity bar, or run `Claude Multi-Session: Open Session Graph`.

## Roadmap

- Hook integration (`PreToolUse` / `PostToolUse` → local HTTP server) for real-time events through a documented interface, and to warn or block when another session is editing the same file
- Worktree-aware path mapping, so the same repo-relative file is matched across git worktrees
- Line-range overlap detection from `Edit.old_string`
- Timeline view

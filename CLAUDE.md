# CLAUDE.md

## Overview

VS Code extension (TypeScript, no bundler) that tails Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`) and shows which files each session reads or edits. It also shows conflicts, pending permission prompts and the skills on disk. [README.md](README.md) is the full user and design doc, including a file-by-file role table. Read it before changing behavior.

## Commands

- `npm install`, then `npm run compile` (`tsc -p ./` → `out/`, which is gitignored). `npm run watch` for incremental builds.
- Run with **F5** (Extension Development Host). [.vscode/launch.json](.vscode/launch.json) passes `--enable-proposed-api Anthropic.claude-code`.
- There is no test suite or linter. Verify with a clean compile and by trying the feature in the Development Host.
- Changes under `media/` only need the graph panel reopened. Changes to `src/` or `package.json` need the debug session restarted.

## Architecture

- All knowledge of the transcript format (not a public API) stays in [src/parser.ts](src/parser.ts). Other modules consume its events.
- A session's cwd is the first `cwd` of its main transcript. Later `cwd` values after a `cd` are ignored.
- Opening a session in Claude Code uses undocumented internals (`claude-vscode.editor.open`, then the `vscode://anthropic.claude-code/open` URI). Log every attempt to the **Claude Multi-Session** output channel.
- VS Code windows coordinate only through files in the extension's global storage: window registration, open requests and the permission events file. No extension API covers this.
- The permission hook receiver always answers `{}` and never makes a decision, so Claude Code always shows its normal prompt.

## Conventions

- Features are documented in README.md in the same commit. A new setting goes in both `package.json` `contributes.configuration` and the README Settings table.
- Commit messages: a plain imperative subject without a type prefix (e.g. "Add a Skills view"), then a wrapped body saying what the change does.
- The `/wrap-up` skill lives in [.claude/skills/wrap-up/SKILL.md](.claude/skills/wrap-up/SKILL.md) and ships with the extension. After editing it, run **Install /wrap-up Skill Globally** so `~/.claude/skills/wrap-up/` is updated.

## Gotchas

- Only sessions whose cwd *equals* a workspace folder can be resumed in that window. A session started in a subfolder needs a window opened on that subfolder.
- If the Claude Sessions activity bar icon is missing and the views appear under Explorer, the cause is Claude Code's proposed API `contribSecondarySidebar`, not this extension. See the README's 문제 해결 (Troubleshooting) section.

---
name: wrap-up
description: Wrap up the current session before its branch is merged. Records what this session learned about the project in CLAUDE.md, so the next session (on a new branch) starts with it. Run it at the end of a branch's work.
disable-model-invocation: true
---

# Wrap up this session

We work one branch per session. A new session starts with CLAUDE.md but none of this session's conversation, so anything the next session needs must be written down now. CLAUDE.md is committed on this branch and reaches `main` with the merge. That is how knowledge is shared between sessions.

## 1. Collect what this session learned

Look at:
- this conversation: decisions, dead ends, corrections the user made, surprises
- the branch's changes: `git log --oneline main..HEAD` and `git diff --stat main...HEAD` (use the repo's default branch if it is not `main`)

## 2. Sort each item

| Kind | Example | Where it goes |
| --- | --- | --- |
| Durable project knowledge | architecture, conventions, build/test commands, non-obvious constraints, gotchas that cost time | **CLAUDE.md** |
| Only about this branch | why this change was made, what is left to do | commit messages / PR description. Not CLAUDE.md |
| The user's personal preference | reply language, commit habits | not this repo. Suggest `~/.claude/CLAUDE.md` to the user |
| Already obvious from the code or git history | file lists, what a function does | nowhere |

Keep only what a future session would otherwise get wrong or spend time rediscovering.

## 3. Update CLAUDE.md

- Merge into the existing sections. Fix or delete statements this session proved wrong or outdated. Do not append a session log.
- Write facts in the present tense ("Transcripts are tailed with fs.watch plus a 5 s poll"), not history ("Today we changed…"). No dates, no session ids.
- Keep it short. Every session loads the whole file. Move long explanations to `docs/` and link them.
- If CLAUDE.md does not exist, create it with only the sections you have content for, from: Overview, Commands, Architecture, Conventions, Gotchas.

## 4. Report and commit

- Show the user the CLAUDE.md diff, plus a short list of the branch-only notes for the PR description.
- Ask before committing. Then commit on the current branch, e.g. `docs: record <topic> in CLAUDE.md`, following the repo's commit conventions.

---
name: wrap-up
description: Wrap up the current session before its branch is merged. Records what this session learned about the project in CLAUDE.md, so the next session (on a new branch) starts with it. Run it at the end of a branch's work.
disable-model-invocation: true
---

# Wrap up this session

We work one branch per session. A new session starts with CLAUDE.md but none of this session's conversation, so anything the next session needs must be written down now. CLAUDE.md is committed on this branch and reaches the branch it merges into (the *target branch*) with the merge. That is how knowledge is shared between sessions.

## 1. Find the target branch

Do not assume `main`. Teams often merge into another long-lived branch, such as `product`, `develop` or a release branch. Use the first of these that applies:

1. The user named it (in this request or earlier in the session).
2. CLAUDE.md states it (e.g. "Feature branches merge into `product`").
3. Infer it. Among the long-lived local and remote branches (not other feature branches), take the one whose `git merge-base` with `HEAD` is the most recent commit. That is the branch this one was created from. Confirm it with the user in one line before using it, e.g. "Target branch: `origin/product`. Right?"

If CLAUDE.md doesn't state the target branch yet and the user confirms one, include that convention in the CLAUDE.md update (step 4).

## 2. Collect what this session learned

Look at:
- this conversation: decisions, dead ends, corrections the user made, surprises
- the branch's changes: `git log --oneline <target>..HEAD` and `git diff --stat <target>...HEAD`

If the branch has already been merged (nothing in `<target>..HEAD`), work from the conversation and the session's commits instead.

## 3. Sort each item

| Kind | Example | Where it goes |
| --- | --- | --- |
| Durable project knowledge | architecture, conventions, build/test commands, non-obvious constraints, gotchas that cost time | **CLAUDE.md** |
| Only about this branch | why this change was made, what is left to do | commit messages / PR description. Not CLAUDE.md |
| The user's personal preference | reply language, commit habits | not this repo. Suggest `~/.claude/CLAUDE.md` to the user |
| Already obvious from the code or git history | file lists, what a function does | nowhere |

Keep only what a future session would otherwise get wrong or spend time rediscovering.

## 4. Update CLAUDE.md

- Merge into the existing sections. Fix or delete statements this session proved wrong or outdated. Do not append a session log.
- Write facts in the present tense ("Transcripts are tailed with fs.watch plus a 5 s poll"), not history ("Today we changed…"). No dates, no session ids.
- Keep it short. Every session loads the whole file. Move long explanations to `docs/` and link them.
- If CLAUDE.md does not exist, create it with only the sections you have content for, from: Overview, Commands, Architecture, Conventions, Gotchas.

## 5. Report and commit

- Show the user the CLAUDE.md diff, plus a short list of the branch-only notes for the PR description.
- Ask before committing. Then commit on the current branch, e.g. `docs: record <topic> in CLAUDE.md`, following the repo's commit conventions.

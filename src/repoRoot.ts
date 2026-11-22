import * as fs from 'fs';
import * as path from 'path';

/** dir key -> repo root (or null = not inside a repo). Filled for every directory visited. */
const cache = new Map<string, string | null>();

const keyOf = (dir: string) => (process.platform === 'win32' || process.platform === 'darwin' ? dir.toLowerCase() : dir);

/**
 * Nearest ancestor of `dir` (inclusive) containing `.git` — a directory for a normal clone,
 * a file for a worktree or submodule. Results are cached per directory; call
 * {@link clearRepoRootCache} after repos may have been created or removed.
 */
export function findRepoRoot(dir: string): string | undefined {
  const visited: string[] = [];
  let d = path.resolve(dir);
  let found: string | null = null;
  for (;;) {
    const cached = cache.get(keyOf(d));
    if (cached !== undefined) {
      found = cached;
      break;
    }
    visited.push(d);
    if (fs.existsSync(path.join(d, '.git'))) {
      found = d;
      break;
    }
    const parent = path.dirname(d);
    if (parent === d) {
      break;
    }
    d = parent;
  }
  for (const v of visited) {
    cache.set(keyOf(v), found);
  }
  return found ?? undefined;
}

export interface RepoIdentity {
  /** Working tree root that contains the file (a linked worktree's own folder, or the main clone). */
  root: string;
  /**
   * Main working tree of the repository. Same as `root` for a normal clone; for a linked worktree
   * (`git worktree add`, Claude Code's `.claude/worktrees/<name>`) it is the clone the worktree
   * belongs to, so the same file in different worktrees maps to one path.
   */
  mainRoot: string;
  /** This working tree's git dir (holds its HEAD). */
  gitDir: string;
  isWorktree: boolean;
}

/** root key -> identity (or null when `.git` could not be read). */
const identityCache = new Map<string, RepoIdentity | null>();

/**
 * Repository identity of the working tree containing `dir`, read from the files git writes
 * (no git process): a worktree's `.git` file says `gitdir: <main>/.git/worktrees/<name>`, and that
 * folder's `commondir` points back to the main `.git`. Submodules have a `.git` file but no
 * `commondir`, so they count as their own repository.
 */
export function findRepoIdentity(dir: string): RepoIdentity | undefined {
  const root = findRepoRoot(dir);
  if (!root) {
    return undefined;
  }
  const k = keyOf(root);
  let id = identityCache.get(k);
  if (id === undefined) {
    id = readIdentity(root);
    identityCache.set(k, id);
  }
  return id ?? undefined;
}

function readIdentity(root: string): RepoIdentity | null {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      return { root, mainRoot: root, gitDir: dotGit, isWorktree: false };
    }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) {
      return null;
    }
    const gitDir = path.resolve(root, nativePath(m[1]));
    const common = readTrimmed(path.join(gitDir, 'commondir'));
    if (!common) {
      return { root, mainRoot: root, gitDir, isWorktree: false }; // submodule
    }
    const commonDir = path.resolve(gitDir, nativePath(common));
    const mainRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir; // bare repo: use its dir
    return { root, mainRoot, gitDir, isWorktree: true };
  } catch {
    return null;
  }
}

/** Branch checked out in a working tree (from its HEAD), or the short commit when detached. */
export function currentBranch(gitDir: string): string | undefined {
  const head = readTrimmed(path.join(gitDir, 'HEAD'));
  if (!head) {
    return undefined;
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return ref ? ref[1] : head.slice(0, 7);
}

/** "feat-x" (branch) plus the worktree folder when it is a linked worktree, for tooltips. */
export function worktreeLabel(filePath: string): string | undefined {
  const id = findRepoIdentity(path.dirname(filePath));
  if (!id) {
    return undefined;
  }
  const branch = currentBranch(id.gitDir) ?? '?';
  return id.isWorktree ? `${branch} (worktree ${path.basename(id.root)})` : branch;
}

function readTrimmed(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Git for Windows may write `/c/...` paths; turn them into `c:\...`. */
function nativePath(p: string): string {
  const m = process.platform === 'win32' ? /^\/([a-zA-Z])(\/.*)?$/.exec(p) : null;
  return m ? `${m[1]}:${m[2] ?? '/'}` : p;
}

export function clearRepoRootCache(): void {
  cache.clear();
  identityCache.clear();
}

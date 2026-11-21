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

export function clearRepoRootCache(): void {
  cache.clear();
}

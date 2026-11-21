import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseLine } from './parser';
import { SessionStore } from './sessionStore';

interface Cursor {
  offset: number;
  /** Incomplete trailing line from the last read. */
  remainder: string;
}

/**
 * Tails every *.jsonl under the Claude projects directory and feeds new lines into the store.
 * Uses fs.watch (recursive) for low latency plus a slow poll as a safety net,
 * since recursive fs.watch can miss events on some platforms / network drives.
 */
export class TranscriptWatcher implements vscode.Disposable {
  private readonly cursors = new Map<string, Cursor>();
  private readonly pending = new Set<string>();
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private reading = false;

  constructor(private readonly store: SessionStore, private readonly log: vscode.OutputChannel) {}

  get projectsDir(): string {
    const cfg = vscode.workspace.getConfiguration('claudeMultisession').get<string>('projectsDir');
    return cfg && cfg.trim() ? cfg : path.join(os.homedir(), '.claude', 'projects');
  }

  start(): void {
    this.stop();
    const dir = this.projectsDir;
    if (!fs.existsSync(dir)) {
      this.log.appendLine(`Projects dir not found: ${dir}`);
      return;
    }
    this.log.appendLine(`Watching ${dir}`);

    try {
      this.watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
        if (filename && filename.toString().endsWith('.jsonl')) {
          this.enqueue(path.join(dir, filename.toString()));
        }
      });
      this.watcher.on('error', (e) => this.log.appendLine(`watch error: ${e}`));
    } catch (e) {
      this.log.appendLine(`fs.watch unavailable, polling only: ${e}`);
    }

    this.scan(true);
    this.pollTimer = setInterval(() => this.scan(false), 5000);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.pollTimer = undefined;
  }

  rescan(): void {
    this.cursors.clear();
    this.store.clear();
    this.start();
  }

  /** Find transcripts modified within the lookback window. */
  private scan(initial: boolean): void {
    const lookbackH = vscode.workspace.getConfiguration('claudeMultisession').get<number>('lookbackHours', 24);
    const cutoff = Date.now() - lookbackH * 3600_000;
    for (const file of walkJsonl(this.projectsDir)) {
      try {
        const st = fs.statSync(file);
        const cur = this.cursors.get(file);
        if (cur ? st.size !== cur.offset : st.mtimeMs >= cutoff) {
          this.enqueue(file);
        }
      } catch {
        /* file vanished */
      }
    }
    if (initial) {
      this.flushSoon(0);
    }
  }

  private enqueue(file: string): void {
    this.pending.add(file);
    this.flushSoon(100);
  }

  private flushSoon(ms: number): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, ms);
  }

  private async flush(): Promise<void> {
    if (this.reading) {
      this.flushSoon(100);
      return;
    }
    this.reading = true;
    try {
      const files = [...this.pending];
      this.pending.clear();
      for (const f of files) {
        await this.readNew(f);
      }
    } finally {
      this.reading = false;
    }
  }

  private async readNew(file: string): Promise<void> {
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return;
    }
    const cur = this.cursors.get(file) ?? { offset: 0, remainder: '' };
    if (size < cur.offset) {
      // Truncated / rewritten: start over.
      cur.offset = 0;
      cur.remainder = '';
    }
    if (size === cur.offset) {
      this.cursors.set(file, cur);
      return;
    }

    const fh = await fs.promises.open(file, 'r');
    try {
      const len = size - cur.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, cur.offset);
      cur.offset = size;

      const text = cur.remainder + buf.toString('utf8');
      const lines = text.split('\n');
      cur.remainder = lines.pop() ?? '';

      const events = lines.filter((l) => l.trim()).flatMap(parseLine);
      this.store.apply(events, file);
    } finally {
      await fh.close();
      this.cursors.set(file, cur);
    }
  }

  dispose(): void {
    this.stop();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
  }
}

function* walkJsonl(dir: string, depth = 0): Generator<string> {
  if (depth > 4) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJsonl(p, depth + 1);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      yield p;
    }
  }
}

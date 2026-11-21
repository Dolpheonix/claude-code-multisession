import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Session, SessionStore } from './sessionStore';

/**
 * Sessions archived in Claude Code ("Archive session" in its session list, or auto-archived after
 * `claudeCode.archiveInactiveSessions` days), so they can be hidden here too.
 *
 * NOTE: Not a documented API; found in anthropic.claude-code 2.1.x. Keep that knowledge in this file.
 *  - The VS Code extension keeps the archived ids in its extension state (`globalState`), key
 *    `hiddenSessionIds`. VS Code stores that in `<user>/globalStorage/state.vscdb` (SQLite), table
 *    `ItemTable`, row `Anthropic.claude-code`, as one JSON object. Read with `node:sqlite`, which
 *    VS Code's runtime (Node 24 in Electron 43) provides. VS Code writes the DB a little after the
 *    change, so polling picks it up within seconds.
 *  - Claude Code can also write `<project dir>/<session id>/archived.json` = { archived, at }.
 *    It stops counting once the transcript has activity after `at`.
 */

interface SqliteDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}

const POLL_MS = 10_000;
const STATE_KEY = 'Anthropic.claude-code';

export class ClaudeArchive implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private warned = false;

  constructor(
    /** This extension's globalStorageUri.fsPath; state.vscdb sits in its parent folder. */
    private readonly globalStoragePath: string,
    private readonly store: SessionStore,
    private readonly log: vscode.OutputChannel,
  ) {}

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  refresh(): void {
    const ids = new Set(this.readStateDb());
    for (const s of this.store.sessions.values()) {
      if (sidecarArchived(s)) {
        ids.add(s.id);
      }
    }
    this.store.setArchived(ids);
  }

  private readStateDb(): string[] {
    const db = path.join(path.dirname(this.globalStoragePath), 'state.vscdb');
    try {
      // node:sqlite is newer than the @types/node this builds against, hence the local typing.
      const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string, opts: { readOnly: boolean }) => SqliteDb };
      const conn = new DatabaseSync(db, { readOnly: true });
      try {
        const row = conn.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STATE_KEY) as { value?: unknown } | undefined;
        const ids = typeof row?.value === 'string' ? JSON.parse(row.value).hiddenSessionIds : undefined;
        return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
      } finally {
        conn.close();
      }
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        this.log.appendLine(`[archive] cannot read Claude Code's archived sessions from ${db}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return [];
    }
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}

/** `<project dir>/<session id>/archived.json`, unless the session was active after it was archived. */
function sidecarArchived(s: Session): boolean {
  if (!s.transcriptPath) {
    return false;
  }
  try {
    const file = path.join(path.dirname(s.transcriptPath), s.id, 'archived.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = Date.parse(json.at);
    return json.archived === true && s.lastTs <= at;
  } catch {
    return false;
  }
}

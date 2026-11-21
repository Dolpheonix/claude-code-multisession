/**
 * Parses one line of a Claude Code transcript (~/.claude/projects/<proj>/<session>.jsonl).
 *
 * NOTE: The transcript format is not a documented public API and may change between
 * Claude Code versions. Keep all format knowledge in this file.
 */

export type AccessKind = 'read' | 'edit';

export type TranscriptEvent =
  | { kind: 'meta'; sessionId: string; cwd?: string; timestamp?: number }
  | { kind: 'title'; sessionId: string; title: string }
  | {
      kind: 'file';
      sessionId: string;
      cwd?: string;
      timestamp: number;
      tool: string;
      access: AccessKind;
      filePath: string;
    };

const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

const READ_TOOLS: Record<string, string> = {
  Read: 'file_path',
};

export function parseLine(line: string): TranscriptEvent[] {
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return [];
  }
  if (!rec || typeof rec !== 'object' || typeof rec.sessionId !== 'string') {
    return [];
  }

  const sessionId: string = rec.sessionId;
  const events: TranscriptEvent[] = [];

  if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
    events.push({ kind: 'title', sessionId, title: rec.aiTitle });
    return events;
  }

  const timestamp = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
  const cwd: string | undefined = typeof rec.cwd === 'string' ? rec.cwd : undefined;

  if (cwd || !Number.isNaN(timestamp)) {
    events.push({
      kind: 'meta',
      sessionId,
      cwd,
      timestamp: Number.isNaN(timestamp) ? undefined : timestamp,
    });
  }

  if (rec.type !== 'assistant') {
    return events;
  }

  const content = rec.message?.content;
  if (!Array.isArray(content)) {
    return events;
  }

  for (const block of content) {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string') {
      continue;
    }
    const editKey = EDIT_TOOLS[block.name];
    const readKey = READ_TOOLS[block.name];
    const key = editKey ?? readKey;
    if (!key) {
      continue;
    }
    const filePath = block.input?.[key];
    if (typeof filePath !== 'string' || !filePath) {
      continue;
    }
    events.push({
      kind: 'file',
      sessionId,
      cwd,
      timestamp: Number.isNaN(timestamp) ? Date.now() : timestamp,
      tool: block.name,
      access: editKey ? 'edit' : 'read',
      filePath,
    });
  }

  return events;
}

import * as vscode from 'vscode';

/**
 * Integration with the official Claude Code VS Code extension.
 *
 * NOTE: Neither entry point is a documented public API; both were found in
 * anthropic.claude-code 2.1.x and may change. Keep that knowledge in this file.
 *  - command `claude-vscode.editor.open(sessionId?, initialPrompt?, ...)` opens/focuses a session tab
 *  - URI `vscode://anthropic.claude-code/open?session=<id>` does the same via the URI handler
 */
const EXTENSION_ID = 'anthropic.claude-code';
const OPEN_COMMAND = 'claude-vscode.editor.open';

export async function openInClaudeCode(sessionId: string, log: vscode.OutputChannel): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  log.appendLine(`[open] session=${sessionId} claudeCode=${ext ? `${ext.packageJSON.version} active=${ext.isActive}` : 'not installed'}`);
  if (!ext) {
    void vscode.window.showWarningMessage('Claude Code extension is not installed.');
    return;
  }
  try {
    if (!ext.isActive) {
      await ext.activate();
    }
    await vscode.commands.executeCommand(OPEN_COMMAND, sessionId);
    log.appendLine(`[open] ${OPEN_COMMAND} ok`);
    return;
  } catch (e) {
    log.appendLine(`[open] ${OPEN_COMMAND} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
  const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://${EXTENSION_ID}/open?session=${encodeURIComponent(sessionId)}`);
  const ok = await vscode.env.openExternal(uri);
  log.appendLine(`[open] fallback ${uri.toString()} -> ${ok}`);
  if (!ok) {
    void vscode.window.showErrorMessage(`Could not open session ${sessionId.slice(0, 8)} in Claude Code.`);
  }
}

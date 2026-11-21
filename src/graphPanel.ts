import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SessionStore } from './sessionStore';
import { buildGraphState } from './viewModel';

type FromWebview =
  | { type: 'ready' }
  | { type: 'openFile'; path: string }
  | { type: 'openSession'; sessionId: string };

export class GraphPanel implements vscode.Disposable {
  private static current: GraphPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, store: SessionStore): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('claudeMultisession.graph', 'Claude Sessions Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media'),
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'cytoscape', 'dist'),
      ],
    });
    GraphPanel.current = new GraphPanel(panel, context, store);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m), null, this.disposables);
    this.disposables.push(store.onDidChange(() => this.post()));
    // Refresh "active" status even when nothing new arrives.
    const t = setInterval(() => this.post(), 30_000);
    this.disposables.push({ dispose: () => clearInterval(t) });
  }

  private post(): void {
    void this.panel.webview.postMessage({ type: 'state', state: buildGraphState(this.store) });
  }

  private onMessage(m: FromWebview): void {
    switch (m.type) {
      case 'ready':
        this.post();
        break;
      case 'openFile':
        void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
        break;
      case 'openSession':
        // Same behavior as the tree: resume in Claude Code if in this workspace, else open the transcript.
        void vscode.commands.executeCommand('claudeMultisession.openSession', m.sessionId);
        break;
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const uri = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
    const nonce = crypto.randomBytes(16).toString('base64');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('media', 'graph.css')}">
<title>Claude Sessions Graph</title>
</head>
<body>
  <header>
    <select id="workspace" title="Filter by workspace (session cwd)">
      <option value="">All workspaces</option>
    </select>
    <label title="Color files touched by 2+ sessions (red: written by 2+, orange: read+write)"><input type="checkbox" id="showConflicts" checked> Conflicts</label>
    <label><input type="checkbox" id="showReads" checked> Show reads</label>
    <label><input type="checkbox" id="sharedOnly"> Shared files only</label>
    <label><input type="checkbox" id="activeOnly"> Active sessions only</label>
    <button id="relayout">Re-layout</button>
    <span id="stats"></span>
  </header>
  <div id="cy"></div>
  <div id="tip"></div>
  <div id="legend">
    <span class="sw session"></span>session
    <span class="sw file"></span>file
    <span class="conflict-legend"><span class="sw rw"></span>read+write by 2+</span>
    <span class="conflict-legend"><span class="sw ww"></span>written by 2+</span>
    <span class="ln edit"></span>edit
    <span class="ln read"></span>read
  </div>
  <script nonce="${nonce}" src="${uri('node_modules', 'cytoscape', 'dist', 'cytoscape.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('media', 'graph.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    GraphPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

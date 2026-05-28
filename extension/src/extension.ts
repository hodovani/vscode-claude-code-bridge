/**
 * Claude Code Workspace Bridge — VS Code Extension v0.5.0
 *
 * On activation:
 *   1. Starts a local HTTP server exposing VS Code workspace intelligence.
 *   2. Syncs the bundled MCP server to a stable path (~/.claude-code-workspace/).
 *   3. Auto-configures ~/.claude.json so Claude Code picks it up immediately.
 *
 * Endpoints:
 *   /health, /symbols, /document-symbols, /hover, /files, /active-editor,
 *   /diagnostics, /definition, /references, /call-hierarchy, /git-status, /search
 */

import * as http from 'http';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';


// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION = '0.8.0';
const EXT_NAME = 'Claude Code Workspace';
const MCP_KEY = 'vscode-workspace';
/** Stable directory written outside the extension so the path survives updates. */
const STABLE_DIR = path.join(os.homedir(), '.claude-code-workspace');
const STABLE_SERVER = path.join(STABLE_DIR, 'mcp-server.mjs');
const SECRET_FILE = path.join(STABLE_DIR, 'secret');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

// ─── Config helpers ───────────────────────────────────────────────────────────

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('claudeCodeWorkspace').get<T>(key) as T;
}

function getPort(): number {
  return cfg<number>('port') || 29837;
}

function resolveClaude(): string | null {
  const configured = (cfg<string>('claudePath') ?? '').trim();
  if (configured) return configured;

  const candidates: string[] = [];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    candidates.push(path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude'));
  }
  candidates.push(
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  );

  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* skip */ }
  }
  return null;
}

// ─── ~/.claude.json helpers ───────────────────────────────────────────────────

type ClaudeConfig = {
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  [key: string]: unknown;
};

async function readClaudeJson(): Promise<ClaudeConfig> {
  try {
    return JSON.parse(await fs.promises.readFile(CLAUDE_JSON, 'utf8')) as ClaudeConfig;
  } catch {
    return {};
  }
}

async function writeClaudeJson(config: ClaudeConfig): Promise<void> {
  await fs.promises.writeFile(CLAUDE_JSON, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function isAlreadyConfigured(config: ClaudeConfig, port: number, secret: string): boolean {
  const entry = config.mcpServers?.[MCP_KEY];
  if (!entry) return false;
  const argPath = entry.args?.[0];
  const portMatch = entry.env?.['VSCODE_BRIDGE_PORT'] === String(port);
  const tokenMatch = entry.env?.['VSCODE_BRIDGE_TOKEN'] === secret;
  return argPath === STABLE_SERVER && portMatch && tokenMatch;
}

// ─── Secret helpers ───────────────────────────────────────────────────────────

async function readOrCreateSecret(): Promise<string> {
  try {
    const existing = (await fs.promises.readFile(SECRET_FILE, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch { /* not present */ }
  const token = crypto.randomBytes(32).toString('hex');
  await fs.promises.mkdir(STABLE_DIR, { recursive: true });
  await fs.promises.writeFile(SECRET_FILE, token, { mode: 0o600 });
  return token;
}

// ─── MCP server sync ──────────────────────────────────────────────────────────

async function syncMcpServer(context: vscode.ExtensionContext): Promise<void> {
  const bundled = path.join(context.extensionPath, 'dist', 'mcp-server.mjs');
  await fs.promises.mkdir(STABLE_DIR, { recursive: true });
  await fs.promises.copyFile(bundled, STABLE_SERVER);
}

// ─── Configure / unconfigure ──────────────────────────────────────────────────

async function configureClaude(port: number): Promise<void> {
  const config = await readClaudeJson();
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[MCP_KEY] = {
    command: 'node',
    args: [STABLE_SERVER],
    env: { VSCODE_BRIDGE_PORT: String(port), VSCODE_BRIDGE_TOKEN: bridgeSecret! },
  };
  await writeClaudeJson(config);
}

async function unconfigureClaude(): Promise<void> {
  const config = await readClaudeJson();
  if (config.mcpServers?.[MCP_KEY]) {
    delete config.mcpServers[MCP_KEY];
    await writeClaudeJson(config);
  }
}

// ─── HTTP bridge ──────────────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

function flattenDocSymbols(symbols: vscode.DocumentSymbol[], depth = 0): object[] {
  const rows: object[] = [];
  for (const s of symbols) {
    rows.push({ name: s.name, kind: vscode.SymbolKind[s.kind] ?? String(s.kind), detail: s.detail || '', startLine: s.range.start.line + 1, endLine: s.range.end.line + 1, depth });
    if (s.children?.length) rows.push(...flattenDocSymbols(s.children, depth + 1));
  }
  return rows;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${getPort()}`);

  const authz = req.headers['authorization'];
  if (authz !== `Bearer ${bridgeSecret}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing bearer token' }));
    return;
  }

  if (url.pathname === '/health') {
    jsonResponse(res, {
      ok: true,
      version: VERSION,
      workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      activeFile: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
    });
    return;
  }

  if (url.pathname === '/symbols') {
    // Ripgrep-based definition search — fast (~1s), language-agnostic, always works.
    // Note: executeWorkspaceSymbolProvider hangs indefinitely in background HTTP handlers,
    // and typescript.tsserverRequest 'navto' is blocked by the TS extension's allowlist.
    const q     = url.searchParams.get('q') ?? '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(cfg<number>('maxSymbols') || 50), 10), 200);
    if (!q) { jsonResponse(res, []); return; }

    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    if (!folders.length) { jsonResponse(res, []); return; }

    const appRoot   = vscode.env.appRoot;
    const bundledRg = path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');
    const rgBin     = cp.execFileSync ? (fs.existsSync(bundledRg) ? bundledRg : 'rg') : 'rg';
    const qe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const baseArgs = [
      '--json', '-m', '1', '--max-filesize', '500K',
      '--glob', '!**/node_modules/**', '--glob', '!**/dist/**',
      '--glob', '!**/.git/**', '--glob', '!**/*.d.ts',
      '--type-add', 'code:*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,cs,cpp,c,h,rb,rs,kt,swift}',
      '--type', 'code', '--',
    ];

    const defPattern = [
      `(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${qe}[\\s(<]`,
      `(export\\s+)?(abstract\\s+)?class\\s+${qe}[\\s{<(]`,
      `(export\\s+)?interface\\s+${qe}[\\s{<]`,
      `(export\\s+)?type\\s+${qe}\\s*[=<]`,
      `(export\\s+)?(const|let|var)\\s+${qe}\\s*[=:]`,
      `(export\\s+)?enum\\s+${qe}[\\s{]`,
      `^\\s+(public|private|protected|static|override|abstract|async|\\s)*\\b${qe}\\s*[(<]`,
      `\\b${qe}\\s*[:=]\\s*(async\\s+)?\\(`,
      `def\\s+${qe}\\(`,
      `func\\s+(\\(\\w+\\s+\\*?\\w+\\)\\s+)?${qe}\\(`,
      `fn\\s+${qe}[\\s<(]`,
    ].join('|');

    const kindOf = (text: string): string => {
      if (/\bclass\b/.test(text))                       return 'Class';
      if (/\binterface\b/.test(text))                   return 'Interface';
      if (/\btype\b/.test(text) && /[=<]/.test(text))   return 'TypeAlias';
      if (/\benum\b/.test(text))                        return 'Enum';
      if (/\b(const|let|var)\b/.test(text))             return 'Variable';
      return 'Function';
    };

    const runRg = (pattern: string): Promise<{ name: string; kind: string; file: string; line: number; preview: string }[]> =>
      new Promise((resolve, reject) => {
        cp.execFile(rgBin as string, [...baseArgs, pattern, ...folders], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err && (err as NodeJS.ErrnoException).code !== 1) { reject(err); return; }
          const rows: { name: string; kind: string; file: string; line: number; preview: string }[] = [];
          for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (msg['type'] !== 'match') continue;
              const data = msg['data'] as Record<string, unknown>;
              const text = ((data['lines'] as Record<string, string>)['text'] ?? '').trim();
              rows.push({ name: q, kind: kindOf(text), file: (data['path'] as Record<string, string>)['text'], line: data['line_number'] as number, preview: text });
              if (rows.length >= limit) break;
            } catch { /* skip */ }
          }
          resolve(rows);
        });
      });

    try {
      let rows = await runRg(defPattern);
      if (rows.length === 0) rows = await runRg(`\\b${qe}\\b`);
      jsonResponse(res, rows);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/document-symbols') {
    const file = url.searchParams.get('file');
    if (!file) { jsonResponse(res, { error: 'file param required' }, 400); return; }
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', vscode.Uri.file(file)),
        8000, 'Document symbol query timed out'
      );
      jsonResponse(res, flattenDocSymbols(raw ?? []));
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/hover') {
    const file = url.searchParams.get('file');
    if (!file) { jsonResponse(res, { error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col  = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        6000, 'Hover timed out'
      );
      const contents = (raw ?? []).flatMap(h =>
        (Array.isArray(h.contents) ? h.contents : [h.contents]).map(c =>
          typeof c === 'string' ? c : (c as vscode.MarkdownString).value ?? ''
        )
      ).filter(Boolean);
      jsonResponse(res, { contents });
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/files') {
    const pattern = url.searchParams.get('pattern') ?? '**/*';
    const exclude = url.searchParams.get('exclude') ?? '**/node_modules/**';
    const limit = parseInt(url.searchParams.get('limit') ?? String(cfg<number>('maxFiles') || 200), 10);
    try {
      const uris = await vscode.workspace.findFiles(pattern, exclude, limit);
      jsonResponse(res, uris.map(u => u.fsPath));
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/active-editor') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { jsonResponse(res, { activeEditor: null }); return; }
    const doc = editor.document;
    const sel = editor.selection;
    jsonResponse(res, {
      activeEditor: {
        file: doc.uri.fsPath,
        language: doc.languageId,
        isDirty: doc.isDirty,
        lineCount: doc.lineCount,
        selection: sel.isEmpty ? null : {
          startLine: sel.start.line + 1, startCol: sel.start.character + 1,
          endLine: sel.end.line + 1, endCol: sel.end.character + 1,
          text: doc.getText(sel),
        },
        openTabs: vscode.window.tabGroups.all
          .flatMap(g => g.tabs)
          .map(t => (t.input as { uri?: vscode.Uri })?.uri?.fsPath)
          .filter((p): p is string => Boolean(p)),
      },
    });
    return;
  }

  if (url.pathname === '/diagnostics') {
    const file     = url.searchParams.get('file');
    const minLevel = (url.searchParams.get('severity') ?? 'all').toLowerCase();
    const sevMap: Record<string, number> = { error: 0, warning: 1, information: 2, hint: 3, all: 3 };
    const maxSev   = sevMap[minLevel] ?? 3;
    try {
      type DiagRow = { file: string; severity: string; message: string; source: string; code: string; startLine: number; startCol: number };
      const toRow = (filePath: string, d: vscode.Diagnostic): DiagRow => ({
        file: filePath,
        severity: (['Error', 'Warning', 'Information', 'Hint'] as const)[d.severity] ?? String(d.severity),
        message: d.message, source: d.source ?? '',
        code: d.code != null ? (typeof d.code === 'object' ? String(d.code.value) : String(d.code)) : '',
        startLine: d.range.start.line + 1, startCol: d.range.start.character + 1,
      });
      const rows = file
        ? vscode.languages.getDiagnostics(vscode.Uri.file(file)).filter(d => d.severity <= maxSev).map(d => toRow(file, d))
        : vscode.languages.getDiagnostics().flatMap(([uri, ds]) => ds.filter(d => d.severity <= maxSev).map(d => toRow(uri.fsPath, d)));
      jsonResponse(res, rows);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/definition') {
    const file = url.searchParams.get('file');
    if (!file) { jsonResponse(res, { error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col  = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Definition query timed out'
      );
      const locs = (raw ?? []).map(l => {
        const { uri, range } = 'targetUri' in l ? { uri: l.targetUri, range: l.targetRange } : l;
        return { file: uri.fsPath, startLine: range.start.line + 1, startCol: range.start.character + 1 };
      });
      jsonResponse(res, locs);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/references') {
    const file  = url.searchParams.get('file');
    if (!file) { jsonResponse(res, { error: 'file param required' }, 400); return; }
    const line  = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col   = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    const limit = parseInt(url.searchParams.get('limit') ?? String(cfg<number>('maxReferences') || 200), 10);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Reference query timed out'
      );
      const locs = (raw ?? []).slice(0, limit).map(l => ({ file: l.uri.fsPath, line: l.range.start.line + 1, col: l.range.start.character + 1 }));
      jsonResponse(res, locs);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/call-hierarchy') {
    const file = url.searchParams.get('file');
    if (!file) { jsonResponse(res, { error: 'file param required' }, 400); return; }
    const line      = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col       = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    const direction = url.searchParams.get('direction') ?? 'incoming';
    const limit     = parseInt(url.searchParams.get('limit') ?? '50', 10);
    try {
      const items = await withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Call hierarchy prepare timed out'
      );
      if (!items?.length) { jsonResponse(res, []); return; }
      const cmd   = direction === 'outgoing' ? 'vscode.provideOutgoingCalls' : 'vscode.provideIncomingCalls';
      const calls = await withTimeout(
        vscode.commands.executeCommand<(vscode.CallHierarchyIncomingCall | vscode.CallHierarchyOutgoingCall)[]>(cmd, items[0]),
        8000, 'Call hierarchy query timed out'
      );
      const rows = (calls ?? []).slice(0, limit).map(c => {
        const sym = direction === 'outgoing' ? (c as vscode.CallHierarchyOutgoingCall).to : (c as vscode.CallHierarchyIncomingCall).from;
        return { name: sym.name, kind: vscode.SymbolKind[sym.kind] ?? String(sym.kind), file: sym.uri.fsPath, line: sym.selectionRange.start.line + 1, col: sym.selectionRange.start.character + 1, callSites: c.fromRanges.length };
      });
      jsonResponse(res, rows);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/git-status') {
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) { jsonResponse(res, { error: 'Git extension not found' }, 404); return; }
      if (!gitExt.isActive) await gitExt.activate();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (gitExt.exports as any).getAPI(1);
      const statusMap: Record<number, string> = { 0:'INDEX_MODIFIED', 1:'INDEX_ADDED', 2:'INDEX_DELETED', 3:'INDEX_RENAMED', 4:'INDEX_COPIED', 5:'MODIFIED', 6:'DELETED', 7:'UNTRACKED', 8:'IGNORED', 9:'INTENT_TO_ADD' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapChange = (c: any) => ({ path: c.uri.fsPath, status: statusMap[c.status] ?? String(c.status) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repos = api.repositories.map((repo: any) => {
        const head = repo.state.HEAD;
        return { root: repo.rootUri.fsPath, branch: head?.name ?? null, commit: head?.commit?.slice(0, 8) ?? null, ahead: head?.ahead ?? 0, behind: head?.behind ?? 0, staged: repo.state.indexChanges.map(mapChange), unstaged: repo.state.workingTreeChanges.map(mapChange), untracked: (repo.state.untrackedChanges ?? []).map(mapChange) };
      });
      jsonResponse(res, repos);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/search') {
    const q          = url.searchParams.get('q');
    if (!q) { jsonResponse(res, { error: 'q param required' }, 400); return; }
    const include    = url.searchParams.get('include');
    const exclude    = url.searchParams.get('exclude');
    const maxResults = Math.min(parseInt(url.searchParams.get('maxResults') ?? '100', 10), cfg<number>('maxSearchResults') || 500);
    const isRegex    = url.searchParams.get('regex') === '1';

    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    if (!folders.length) { jsonResponse(res, []); return; }

    const appRoot   = vscode.env.appRoot;
    const bundledRg = path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');
    const rgBin     = fs.existsSync(bundledRg) ? bundledRg : 'rg';

    const args = ['--json', '-m', String(maxResults), '--max-filesize', '1M'];
    if (!isRegex) args.push('--fixed-strings');
    if (include) args.push('--glob', include);
    if (exclude) { for (const g of exclude.split(',')) args.push('--glob', `!${g.trim()}`); }
    args.push('--', q, ...folders);

    try {
      const results = await new Promise<{ file: string; line: number; col: number; preview: string }[]>((resolve, reject) => {
        cp.execFile(rgBin as string, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err && (err as NodeJS.ErrnoException).code !== 1) { reject(err); return; }
          const rows: { file: string; line: number; col: number; preview: string }[] = [];
          for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (msg['type'] === 'match') {
                const data = msg['data'] as Record<string, unknown>;
                rows.push({ file: (data['path'] as Record<string, string>)['text'], line: data['line_number'] as number, col: ((data['submatches'] as Record<string, number>[])[0]?.['start'] ?? 0) + 1, preview: (data['lines'] as Record<string, string>)['text'].trimEnd() });
                if (rows.length >= maxResults) break;
              }
            } catch { /* skip */ }
          }
          resolve(rows);
        });
      });
      jsonResponse(res, results);
    } catch (e) { jsonResponse(res, { error: String(e) }, 500); }
    return;
  }

  jsonResponse(res, { error: 'Not found' }, 404);
}

// ─── Chat participant ─────────────────────────────────────────────────────────

function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant('claude-code-workspace.claude', async (request, _ctx, stream, token) => {
    const claudeBin = resolveClaude();
    if (!claudeBin) {
      stream.markdown('**Claude Code not found.** Set `claudeCodeWorkspace.claudePath` in Settings to the path of the `claude` CLI.');
      return;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    stream.markdown('_Asking Claude Code…_\n\n');
    await new Promise<void>((resolve, reject) => {
      const proc = cp.spawn(claudeBin, ['--print', '--output-format', 'stream-json', '--no-color', request.prompt], { cwd, env: process.env });
      let buf = '';
      const flush = (t: string) => { if (t) stream.markdown(t); };
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg['type'] === 'assistant') {
              for (const b of (msg['message'] as Record<string, unknown[]>)?.['content'] ?? []) {
                const block = b as Record<string, unknown>;
                if (block['type'] === 'text') flush(String(block['text']));
              }
            } else if (msg['type'] === 'text') flush(String(msg['text']));
            else if (msg['type'] === 'result' && msg['result']) flush(String(msg['result']));
          } catch { flush(line + '\n'); }
        }
      });
      proc.stderr.on('data', (c: Buffer) => console.error('[Claude Code Workspace]', c.toString()));
      proc.on('close', code => { if (buf.trim()) flush(buf); code === 0 ? resolve() : reject(new Error(`claude exited ${code}`)); });
      proc.on('error', reject);
      token.onCancellationRequested(() => { proc.kill(); reject(new Error('Cancelled')); });
    }).catch(e => { if ((e as Error).message !== 'Cancelled') stream.markdown(`\n\n> **Error:** ${(e as Error).message}`); });
  });
  participant.iconPath = new vscode.ThemeIcon('robot');
  context.subscriptions.push(participant);
}

// ─── Bridge server ────────────────────────────────────────────────────────────

let bridgeServer: http.Server | undefined;
let bridgeSecret: string | undefined;
let statusBar: vscode.StatusBarItem | undefined;

function setStatus(text: string, tooltip: string, isError = false): void {
  if (!statusBar) return;
  statusBar.text = text;
  statusBar.tooltip = tooltip;
  statusBar.backgroundColor = isError ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

function startBridgeServer(context: vscode.ExtensionContext): void {
  const port = getPort();
  bridgeServer = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      console.error('[Claude Code Workspace]', e);
    });
  });
  bridgeServer.listen(port, '127.0.0.1', () => {
    setStatus('$(plug) Claude Bridge', `Claude Code Workspace bridge active on port ${port}`);
  });
  bridgeServer.on('error', (err: NodeJS.ErrnoException) => {
    const msg = err.code === 'EADDRINUSE'
      ? `Port ${port} already in use — another instance may be running, or change the port in Settings.`
      : `Bridge error: ${err.message}`;
    setStatus('$(warning) Claude Bridge', msg, true);
    vscode.window.showWarningMessage(`${EXT_NAME}: ${msg}`);
  });
  context.subscriptions.push({ dispose: () => bridgeServer?.close() });
}

// ─── First-run setup ──────────────────────────────────────────────────────────

async function promptSetup(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `${EXT_NAME}: Configure Claude Code to use VS Code's workspace intelligence?`,
    'Set Up', 'Not Now'
  );
  if (choice !== 'Set Up') return;

  await configureClaude(getPort());
  const restart = await vscode.window.showInformationMessage(
    `${EXT_NAME}: All set! Restart Claude Code to activate the workspace bridge.`,
    'OK'
  );
  void restart;
}

// ─── Activation ───────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Status bar
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(loading~spin) Claude Bridge';
  statusBar.tooltip = `${EXT_NAME} starting…`;
  statusBar.command = 'claudeCodeWorkspace.configure';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Sync bundled MCP server to stable path (runs on every activation, so updates auto-propagate)
  try {
    await syncMcpServer(context);
  } catch (e) {
    console.error('[Claude Code Workspace] Failed to sync MCP server:', e);
  }

  // Read or create the shared secret before starting the bridge
  try {
    bridgeSecret = await readOrCreateSecret();
  } catch (e) {
    console.error('[Claude Code Workspace] Failed to read/create secret:', e);
    vscode.window.showErrorMessage(`${EXT_NAME}: failed to initialise auth token; bridge disabled.`);
    return;
  }

  // Start HTTP bridge
  startBridgeServer(context);

  // Register chat participant
  registerChatParticipant(context);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeWorkspace.configure', async () => {
      await configureClaude(getPort());
      vscode.window.showInformationMessage(`${EXT_NAME}: Claude Code configured. Restart Claude Code to apply.`);
    }),
    vscode.commands.registerCommand('claudeCodeWorkspace.unconfigure', async () => {
      await unconfigureClaude();
      vscode.window.showInformationMessage(`${EXT_NAME}: Removed from Claude Code configuration.`);
    }),
  );

  // Restart bridge when port changes; re-configure claude.json with new port
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('claudeCodeWorkspace.port')) {
        bridgeServer?.close(() => startBridgeServer(context));
        const config = await readClaudeJson();
        if (config.mcpServers?.[MCP_KEY]) await configureClaude(getPort());
      }
    })
  );

  // First-run: prompt if not yet configured
  const config = await readClaudeJson();
  if (!isAlreadyConfigured(config, getPort(), bridgeSecret!)) {
    await promptSetup();
  }
}

export function deactivate(): void {
  bridgeServer?.close();
  statusBar?.dispose();
}

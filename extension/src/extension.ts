/**
 * Claude Code Workspace Bridge — VS Code Extension v0.10.0
 *
 * On activation:
 *   1. Starts a local HTTP server exposing VS Code workspace intelligence.
 *   2. Syncs the bundled MCP server to a stable path (~/.claude-code-workspace/).
 *   3. Auto-configures ~/.claude.json so Claude Code picks it up immediately.
 *
 * Endpoints:
 *   /health, /symbols, /document-symbols, /hover, /files, /active-editor,
 *   /diagnostics, /definition, /references, /call-hierarchy, /git-status, /search,
 *   /type-definition, /implementation, /declaration, /signature-help, /completion,
 *   /inlay-hints, /document-highlights, /rename, /code-actions, /apply-code-action,
 *   /format, /format-range, /organize-imports, /fix-all
 */

import * as http from 'http';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';


// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION = '0.10.0';
const EXT_NAME = 'Claude Code Workspace';
const MCP_KEY = 'vscode-workspace';
/** Stable directory written outside the extension so the path survives updates. */
const STABLE_DIR = path.join(os.homedir(), '.claude-code-workspace');
const STABLE_SERVER = path.join(STABLE_DIR, 'mcp-server.mjs');
const SECRET_FILE = path.join(STABLE_DIR, 'secret');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

// ─── Output channel ───────────────────────────────────────────────────────────

let output: vscode.OutputChannel | undefined;
function log(line: string): void {
  output?.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${line}`);
}

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

function translateError(e: unknown): string {
  const raw = String(e);
  if (/Unexpected type/i.test(raw)) {
    return 'Language server is in an unexpected state. The bridge auto-opens documents for rename/refactor — if you see this on other operations, ensure the file is in an active language project (tsconfig.json / pyproject.toml / pom.xml / etc.) and the relevant VS Code language extension is enabled.';
  }
  if (/Illegal argument/i.test(raw)) {
    return 'Position out of range or invalid argument. Verify line/col are 1-based and within the file. For code_actions, ensure startLine ≤ endLine and the range is non-empty.';
  }
  if (/Cannot find module/i.test(raw) || /not in tsconfig/i.test(raw)) {
    return 'File is not in any active language project. Check that the file is included by tsconfig.json / jsconfig.json / pyproject.toml / etc., and that the corresponding language server has loaded it.';
  }
  if (/timed out/i.test(raw)) {
    return `${raw} — try restarting the language server: Cmd+Shift+P → "<Language>: Restart Server", or check the Claude Code Workspace output channel for details.`;
  }
  return raw;
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
    log(`← ${req.method} ${url.pathname} 401 (auth)`);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing bearer token' }));
    return;
  }

  const startTime = Date.now();
  log(`→ ${req.method} ${url.pathname}${url.search}`);

  const respond = (data: unknown, status = 200): void => {
    log(`← ${req.method} ${url.pathname} ${status} (${Date.now() - startTime}ms)`);
    jsonResponse(res, data, status);
  };

  if (url.pathname === '/health') {
    respond({
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
    if (!q) { respond([]); return; }

    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    if (!folders.length) { respond([]); return; }

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
      respond(rows);
    } catch (e) { log(`! /symbols: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/document-symbols') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', vscode.Uri.file(file)),
        8000, 'Document symbol query timed out'
      );
      respond(flattenDocSymbols(raw ?? []));
    } catch (e) { log(`! /document-symbols: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/hover') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
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
      respond({ contents });
    } catch (e) { log(`! /hover: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/files') {
    const pattern = url.searchParams.get('pattern') ?? '**/*';
    const exclude = url.searchParams.get('exclude') ?? '**/node_modules/**';
    const limit = parseInt(url.searchParams.get('limit') ?? String(cfg<number>('maxFiles') || 200), 10);
    try {
      const uris = await vscode.workspace.findFiles(pattern, exclude, limit);
      respond(uris.map(u => u.fsPath));
    } catch (e) { log(`! /files: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/active-editor') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { respond({ activeEditor: null }); return; }
    const doc = editor.document;
    const sel = editor.selection;
    respond({
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
      respond(rows);
    } catch (e) { log(`! /diagnostics: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/definition') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
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
      respond(locs);
    } catch (e) { log(`! /definition: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/references') {
    const file  = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const line  = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col   = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    const limit = parseInt(url.searchParams.get('limit') ?? String(cfg<number>('maxReferences') || 200), 10);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Reference query timed out'
      );
      const locs = (raw ?? []).slice(0, limit).map(l => ({ file: l.uri.fsPath, line: l.range.start.line + 1, col: l.range.start.character + 1 }));
      respond(locs);
    } catch (e) { log(`! /references: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/call-hierarchy') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const line      = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col       = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    const direction = url.searchParams.get('direction') ?? 'incoming';
    const limit     = parseInt(url.searchParams.get('limit') ?? '50', 10);
    try {
      const items = await withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Call hierarchy prepare timed out'
      );
      if (!items?.length) { respond([]); return; }
      const cmd   = direction === 'outgoing' ? 'vscode.provideOutgoingCalls' : 'vscode.provideIncomingCalls';
      const calls = await withTimeout(
        vscode.commands.executeCommand<(vscode.CallHierarchyIncomingCall | vscode.CallHierarchyOutgoingCall)[]>(cmd, items[0]),
        8000, 'Call hierarchy query timed out'
      );
      const rows = (calls ?? []).slice(0, limit).map(c => {
        const sym = direction === 'outgoing' ? (c as vscode.CallHierarchyOutgoingCall).to : (c as vscode.CallHierarchyIncomingCall).from;
        return { name: sym.name, kind: vscode.SymbolKind[sym.kind] ?? String(sym.kind), file: sym.uri.fsPath, line: sym.selectionRange.start.line + 1, col: sym.selectionRange.start.character + 1, callSites: c.fromRanges.length };
      });
      respond(rows);
    } catch (e) { log(`! /call-hierarchy: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/git-status') {
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) { respond({ error: 'Git extension not found' }, 404); return; }
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
      respond(repos);
    } catch (e) { log(`! /git-status: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/search') {
    const q          = url.searchParams.get('q');
    if (!q) { respond({ error: 'q param required' }, 400); return; }
    const include    = url.searchParams.get('include');
    const exclude    = url.searchParams.get('exclude');
    const maxResults = Math.min(parseInt(url.searchParams.get('maxResults') ?? '100', 10), cfg<number>('maxSearchResults') || 500);
    const isRegex    = url.searchParams.get('regex') === '1';

    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    if (!folders.length) { respond([]); return; }

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
      respond(results);
    } catch (e) { log(`! /search: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/type-definition') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col  = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeTypeDefinitionProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Type definition query timed out'
      );
      const locs = (raw ?? []).map(l => {
        const { uri, range } = 'targetUri' in l ? { uri: l.targetUri, range: l.targetRange } : l;
        return { file: uri.fsPath, startLine: range.start.line + 1, startCol: range.start.character + 1 };
      });
      respond(locs);
    } catch (e) { log(`! /type-definition: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/implementation') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col  = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeImplementationProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Implementation query timed out'
      );
      const locs = (raw ?? []).map(l => {
        const { uri, range } = 'targetUri' in l ? { uri: l.targetUri, range: l.targetRange } : l;
        return { file: uri.fsPath, startLine: range.start.line + 1, startCol: range.start.character + 1 };
      });
      respond(locs);
    } catch (e) { log(`! /implementation: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/declaration') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col  = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDeclarationProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Declaration query timed out'
      );
      const locs = (raw ?? []).map(l => {
        const { uri, range } = 'targetUri' in l ? { uri: l.targetUri, range: l.targetRange } : l;
        return { file: uri.fsPath, startLine: range.start.line + 1, startCol: range.start.character + 1 };
      });
      respond(locs);
    } catch (e) { log(`! /declaration: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/signature-help') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col  = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Signature help timed out'
      );
      if (!raw) { respond(null); return; }
      const result = {
        signatures: raw.signatures.map(sig => ({
          label: sig.label,
          documentation: typeof sig.documentation === 'string' ? sig.documentation : (sig.documentation as vscode.MarkdownString | undefined)?.value ?? '',
          parameters: sig.parameters.map(p => ({
            label: Array.isArray(p.label) ? p.label.join('-') : p.label,
            documentation: typeof p.documentation === 'string' ? p.documentation : (p.documentation as vscode.MarkdownString | undefined)?.value ?? '',
          })),
        })),
        activeSignature: raw.activeSignature ?? 0,
        activeParameter: raw.activeParameter ?? 0,
      };
      respond(result);
    } catch (e) { log(`! /signature-help: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/completion') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const line  = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col   = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Completion timed out'
      );
      const items = ((raw?.items ?? []) as vscode.CompletionItem[]).slice(0, limit).map(d => ({
        label: typeof d.label === 'string' ? d.label : (d.label as vscode.CompletionItemLabel).label,
        kind: vscode.CompletionItemKind[d.kind ?? 0] ?? String(d.kind),
        detail: d.detail ?? '',
        documentation: typeof d.documentation === 'string' ? d.documentation : (d.documentation as vscode.MarkdownString | undefined)?.value ?? '',
        insertText: typeof d.insertText === 'string' ? d.insertText : (d.insertText as vscode.SnippetString | undefined)?.value ?? (typeof d.label === 'string' ? d.label : (d.label as vscode.CompletionItemLabel).label),
        sortText: d.sortText ?? '',
      }));
      respond(items);
    } catch (e) { log(`! /completion: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/inlay-hints') {
    const file      = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const startLine = Math.max(0, parseInt(url.searchParams.get('startLine') ?? '1', 10) - 1);
    const endLine   = Math.max(0, parseInt(url.searchParams.get('endLine')   ?? '1', 10) - 1);
    try {
      const range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, Number.MAX_SAFE_INTEGER));
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', vscode.Uri.file(file), range),
        8000, 'Inlay hints timed out'
      );
      const hints = (raw ?? []).map(h => ({
        line: h.position.line + 1,
        col: h.position.character + 1,
        label: Array.isArray(h.label) ? h.label.map(p => (typeof p === 'string' ? p : p.value)).join('') : h.label,
        kind: vscode.InlayHintKind[h.kind ?? 0] ?? String(h.kind),
        paddingLeft: h.paddingLeft ?? false,
        paddingRight: h.paddingRight ?? false,
      }));
      respond(hints);
    } catch (e) { log(`! /inlay-hints: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/document-highlights') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const line = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col  = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.DocumentHighlight[]>('vscode.executeDocumentHighlights', vscode.Uri.file(file), new vscode.Position(line, col)),
        8000, 'Document highlights timed out'
      );
      const highlights = (raw ?? []).map(h => ({
        startLine: h.range.start.line + 1,
        startCol: h.range.start.character + 1,
        endLine: h.range.end.line + 1,
        endCol: h.range.end.character + 1,
        kind: vscode.DocumentHighlightKind[h.kind ?? vscode.DocumentHighlightKind.Text] ?? String(h.kind),
      }));
      respond(highlights);
    } catch (e) { log(`! /document-highlights: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/rename') {
    const file    = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const newName = url.searchParams.get('newName');
    if (!newName) { respond({ error: 'newName param required' }, 400); return; }
    const line  = Math.max(0, parseInt(url.searchParams.get('line') ?? '1', 10) - 1);
    const col   = Math.max(0, parseInt(url.searchParams.get('col')  ?? '1', 10) - 1);
    const apply = url.searchParams.get('apply') === '1' || url.searchParams.get('apply') === 'true';
    // The rename provider requires the document to be loaded into VS Code's text model.
    // Pre-open AND warm the language server by triggering documentSymbolProvider,
    // which forces the TS/Python/etc. server to attach to the document before rename runs.
    try { await vscode.workspace.openTextDocument(vscode.Uri.file(file)); }
    catch (e) { log(`! /rename openTextDocument: ${String(e)}`); respond({ error: `openTextDocument: ${translateError(e)}`, rawError: String(e) }, 500); return; }
    try { await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', vscode.Uri.file(file)); }
    catch { /* warming is best-effort */ }
    let edit: vscode.WorkspaceEdit | undefined;
    // Retry on empty edit — first-after-restart TS calls can return an empty WorkspaceEdit.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        edit = await withTimeout(
          vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', vscode.Uri.file(file), new vscode.Position(line, col), newName),
          8000, 'Rename timed out'
        );
      } catch (e) { log(`! /rename executeCommand: ${String(e)}`); respond({ error: `executeCommand: ${translateError(e)}`, rawError: String(e) }, 500); return; }
      if (edit && edit.size > 0) break;
      if (attempt < 2) await new Promise(r => setTimeout(r, 300));
    }
    if (!edit) { respond({ preview: [], applied: false }); return; }
    const preview: { file: string; edits: { startLine: number; startCol: number; endLine: number; endCol: number; newText: string }[] }[] = [];
    let entries: ReadonlyArray<[vscode.Uri, vscode.TextEdit[]]>;
    try { entries = edit.entries(); }
    catch (e) { log(`! /rename edit.entries(): ${String(e)}`); respond({ error: `edit.entries(): ${translateError(e)}`, rawError: String(e) }, 500); return; }
    for (let i = 0; i < entries.length; i++) {
      try {
        const [uri, textEdits] = entries[i];
        const fpath = (uri as { fsPath?: string }).fsPath ?? (uri && typeof (uri as { toString?: () => string }).toString === 'function' ? (uri as { toString: () => string }).toString() : String(uri));
        preview.push({
          file: fpath,
          edits: (textEdits ?? []).map(te => {
            const r = (te as { range?: vscode.Range }).range;
            return {
              startLine: (r?.start?.line ?? 0) + 1,
              startCol:  (r?.start?.character ?? 0) + 1,
              endLine:   (r?.end?.line ?? 0) + 1,
              endCol:    (r?.end?.character ?? 0) + 1,
              newText:   (te as { newText?: string }).newText ?? '',
            };
          }),
        });
      } catch (e) {
        log(`! /rename entry[${i}]: ${String(e)}`);
        respond({ error: `entry[${i}]: ${translateError(e)}`, rawError: String(e), preview }, 500);
        return;
      }
    }
    if (!apply) { respond({ preview, applied: false }); return; }
    let applied = false;
    try { applied = await vscode.workspace.applyEdit(edit); }
    catch (e) { log(`! /rename applyEdit: ${String(e)}`); respond({ error: `applyEdit: ${translateError(e)}`, rawError: String(e), preview }, 500); return; }
    // applyEdit modifies in-memory documents but doesn't save. Persist them.
    let saved = 0;
    if (applied) {
      for (const [uri] of entries) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (doc.isDirty && await doc.save()) saved++;
        } catch { /* skip individual save failures */ }
      }
    }
    respond({ preview, applied, saved });
    return;
  }

  if (url.pathname === '/code-actions') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const startLine = Math.max(0, parseInt(url.searchParams.get('startLine') ?? '1', 10) - 1);
    const startCol  = Math.max(0, parseInt(url.searchParams.get('startCol')  ?? '1', 10) - 1);
    const endLine   = Math.max(0, parseInt(url.searchParams.get('endLine')   ?? url.searchParams.get('startLine') ?? '1', 10) - 1);
    const endCol    = Math.max(0, parseInt(url.searchParams.get('endCol')    ?? url.searchParams.get('startCol')  ?? '1', 10) - 1);
    const kindFilter = url.searchParams.get('kindFilter');
    try {
      const range = new vscode.Range(new vscode.Position(startLine, startCol), new vscode.Position(endLine, endCol));
      const kind  = kindFilter ? new vscode.CodeActionKind(kindFilter) : undefined;
      const raw = await withTimeout(
        vscode.commands.executeCommand<(vscode.Command | vscode.CodeAction)[]>('vscode.executeCodeActionProvider', vscode.Uri.file(file), range, kind?.value),
        8000, 'Code actions timed out'
      );
      const actions = (raw ?? []).map((a, index) => {
        if ('command' in a && typeof (a as vscode.Command).command === 'string' && !('title' in a && typeof (a as { title?: unknown }).title === 'string' && !('kind' in a))) {
          const cmd = a as vscode.Command;
          return { title: cmd.title, kind: '', isPreferred: false, index };
        }
        const ca = a as vscode.CodeAction;
        return {
          title: ca.title,
          kind: ca.kind?.value ?? '',
          isPreferred: ca.isPreferred ?? false,
          index,
        };
      });
      respond(actions);
    } catch (e) { log(`! /code-actions: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  if (url.pathname === '/apply-code-action') {
    const file = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const startLine  = Math.max(0, parseInt(url.searchParams.get('startLine') ?? '1', 10) - 1);
    const startCol   = Math.max(0, parseInt(url.searchParams.get('startCol')  ?? '1', 10) - 1);
    const endLine    = Math.max(0, parseInt(url.searchParams.get('endLine')   ?? url.searchParams.get('startLine') ?? '1', 10) - 1);
    const endCol     = Math.max(0, parseInt(url.searchParams.get('endCol')    ?? url.searchParams.get('startCol')  ?? '1', 10) - 1);
    const kindFilter = url.searchParams.get('kindFilter');
    const actionIndexStr = url.searchParams.get('actionIndex');
    if (actionIndexStr === null) { respond({ error: 'actionIndex param required' }, 400); return; }
    const actionIndex = parseInt(actionIndexStr, 10);
    try {
      const range = new vscode.Range(new vscode.Position(startLine, startCol), new vscode.Position(endLine, endCol));
      const kind  = kindFilter ? new vscode.CodeActionKind(kindFilter) : undefined;
      const raw = await withTimeout(
        vscode.commands.executeCommand<(vscode.Command | vscode.CodeAction)[]>('vscode.executeCodeActionProvider', vscode.Uri.file(file), range, kind?.value),
        8000, 'Code actions timed out'
      );
      const actions = raw ?? [];
      if (actionIndex < 0 || actionIndex >= actions.length) {
        respond({ applied: false, title: '' });
        return;
      }
      const action = actions[actionIndex];
      const ca = action as vscode.CodeAction;
      const title = ca.title ?? (action as vscode.Command).title ?? '';
      let applied = false;
      if (ca.edit) {
        applied = await vscode.workspace.applyEdit(ca.edit);
      }
      if (ca.command) {
        await vscode.commands.executeCommand(ca.command.command, ...(ca.command.arguments ?? []));
        applied = true;
      }
      respond({ applied, title });
    } catch (e) { log(`! /apply-code-action: ${String(e)}`); respond({ error: translateError(e) }, 500); }
    return;
  }

  // ── Tier C: format, format-range, organize-imports, fix-all ─────────────────

  if (url.pathname === '/format' || url.pathname === '/format-range') {
    const file  = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const apply = url.searchParams.get('apply') === '1' || url.searchParams.get('apply') === 'true';
    const uri   = vscode.Uri.file(file);
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch (e) { log(`! ${url.pathname} openTextDocument: ${String(e)}`); respond({ error: `openTextDocument: ${translateError(e)}`, rawError: String(e) }, 500); return; }
    try {
      const options = { tabSize: 2, insertSpaces: true };
      let textEdits: vscode.TextEdit[] | undefined;
      if (url.pathname === '/format-range') {
        const sl = Math.max(0, parseInt(url.searchParams.get('startLine') ?? '1', 10) - 1);
        const sc = Math.max(0, parseInt(url.searchParams.get('startCol')  ?? '1', 10) - 1);
        const el = Math.max(0, parseInt(url.searchParams.get('endLine')   ?? url.searchParams.get('startLine') ?? '1', 10) - 1);
        const ec = Math.max(0, parseInt(url.searchParams.get('endCol')    ?? url.searchParams.get('startCol')  ?? '1', 10) - 1);
        const range = new vscode.Range(new vscode.Position(sl, sc), new vscode.Position(el, ec));
        textEdits = await withTimeout(
          vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatRangeProvider', uri, range, options),
          8000, 'Format range timed out'
        );
      } else {
        textEdits = await withTimeout(
          vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri, options),
          8000, 'Format document timed out'
        );
      }
      const edits = (textEdits ?? []).map(te => ({
        startLine: te.range.start.line + 1,
        startCol:  te.range.start.character + 1,
        endLine:   te.range.end.line + 1,
        endCol:    te.range.end.character + 1,
        newText:   te.newText,
      }));
      const preview = [{ file, edits }];
      if (!apply || edits.length === 0) { respond({ preview, applied: false, saved: 0 }); return; }
      const wsEdit = new vscode.WorkspaceEdit();
      for (const te of textEdits ?? []) wsEdit.replace(uri, te.range, te.newText);
      const applied = await vscode.workspace.applyEdit(wsEdit);
      let saved = 0;
      if (applied) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (doc.isDirty && await doc.save()) saved = 1;
        } catch { /* ignore */ }
      }
      respond({ preview, applied, saved });
    } catch (e) { log(`! ${url.pathname}: ${String(e)}`); respond({ error: translateError(e), rawError: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/organize-imports') {
    const file  = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const apply = url.searchParams.get('apply') === '1' || url.searchParams.get('apply') === 'true';
    const uri   = vscode.Uri.file(file);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(doc.lineCount - 1, Number.MAX_SAFE_INTEGER));
      const raw = await withTimeout(
        vscode.commands.executeCommand<(vscode.Command | vscode.CodeAction)[]>('vscode.executeCodeActionProvider', uri, fullRange, 'source.organizeImports'),
        8000, 'Organize imports timed out'
      );
      const actions = (raw ?? []) as vscode.CodeAction[];
      if (!actions.length) { respond({ preview: [], applied: false, saved: 0, commandOnly: false }); return; }
      const first = actions[0];
      if (!first.edit && first.command) {
        if (apply) {
          await vscode.commands.executeCommand(first.command.command, ...(first.command.arguments ?? []));
          let saved = 0;
          try { const d = await vscode.workspace.openTextDocument(uri); if (d.isDirty && await d.save()) saved = 1; } catch { /* ignore */ }
          respond({ preview: [], applied: true, saved, commandOnly: true });
        } else {
          respond({ preview: [], applied: false, saved: 0, commandOnly: true });
        }
        return;
      }
      const preview = first.edit ? (() => {
        const out: { file: string; edits: object[] }[] = [];
        for (const [u, tes] of first.edit.entries()) {
          out.push({ file: (u as { fsPath: string }).fsPath, edits: tes.map(te => ({ startLine: te.range.start.line + 1, startCol: te.range.start.character + 1, endLine: te.range.end.line + 1, endCol: te.range.end.character + 1, newText: te.newText })) });
        }
        return out;
      })() : [];
      if (!apply) { respond({ preview, applied: false, saved: 0, commandOnly: false }); return; }
      let applied = false;
      if (first.edit) applied = await vscode.workspace.applyEdit(first.edit);
      if (first.command) { await vscode.commands.executeCommand(first.command.command, ...(first.command.arguments ?? [])); applied = true; }
      let saved = 0;
      if (applied) { try { const d = await vscode.workspace.openTextDocument(uri); if (d.isDirty && await d.save()) saved = 1; } catch { /* ignore */ } }
      respond({ preview, applied, saved, commandOnly: false });
    } catch (e) { log(`! /organize-imports: ${String(e)}`); respond({ error: translateError(e), rawError: String(e) }, 500); }
    return;
  }

  if (url.pathname === '/fix-all') {
    const file  = url.searchParams.get('file');
    if (!file) { respond({ error: 'file param required' }, 400); return; }
    const apply = url.searchParams.get('apply') === '1' || url.searchParams.get('apply') === 'true';
    const uri   = vscode.Uri.file(file);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(doc.lineCount - 1, Number.MAX_SAFE_INTEGER));
      const raw = await withTimeout(
        vscode.commands.executeCommand<(vscode.Command | vscode.CodeAction)[]>('vscode.executeCodeActionProvider', uri, fullRange, 'source.fixAll'),
        8000, 'Fix all timed out'
      );
      const actions = (raw ?? []) as vscode.CodeAction[];
      if (!actions.length) { respond({ preview: [], applied: 0, saved: 0 }); return; }
      const allPreview: { file: string; edits: object[] }[] = [];
      let appliedCount = 0;
      for (const action of actions) {
        if (action.edit) {
          for (const [u, tes] of action.edit.entries()) {
            allPreview.push({ file: (u as { fsPath: string }).fsPath, edits: tes.map(te => ({ startLine: te.range.start.line + 1, startCol: te.range.start.character + 1, endLine: te.range.end.line + 1, endCol: te.range.end.character + 1, newText: te.newText })) });
          }
        }
      }
      if (!apply) { respond({ preview: allPreview, applied: 0, saved: 0 }); return; }
      for (const action of actions) {
        if (action.edit) { if (await vscode.workspace.applyEdit(action.edit)) appliedCount++; }
        if (action.command) { await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? [])); appliedCount++; }
      }
      let saved = 0;
      if (appliedCount > 0) { try { const d = await vscode.workspace.openTextDocument(uri); if (d.isDirty && await d.save()) saved = 1; } catch { /* ignore */ } }
      respond({ preview: allPreview, applied: appliedCount, saved });
    } catch (e) { log(`! /fix-all: ${String(e)}`); respond({ error: translateError(e), rawError: String(e) }, 500); }
    return;
  }

  respond({ error: 'Not found' }, 404);
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
  // Output channel — create BEFORE anything else so log() works from the start
  output = vscode.window.createOutputChannel('Claude Code Workspace');
  context.subscriptions.push(output);
  log(`Activating extension v${VERSION}`);

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
  output?.dispose();
}

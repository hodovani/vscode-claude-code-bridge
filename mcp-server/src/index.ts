#!/usr/bin/env node
/**
 * MCP server — VS Code Workspace Bridge v0.3.0
 *
 * Tools:
 *   bridge_health      → VS Code status, active file, open tabs
 *   workspace_symbols  → LSP workspace symbol search
 *   document_symbols   → outline of a specific file
 *   find_files         → glob file search
 *   active_editor      → current file, selection, open tabs
 *   diagnostics        → VS Code Problems panel (errors/warnings)
 *   hover              → TypeScript type info + JSDoc at a position
 *   definition         → go-to-definition via LSP
 *   references         → find-all-references via LSP
 *   call_hierarchy     → incoming/outgoing call chains
 *   git_status         → branch, staged/unstaged changes per repo
 *   text_search        → ripgrep full-text search
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE = `http://127.0.0.1:${process.env['VSCODE_BRIDGE_PORT'] ?? '29837'}`;
const TOKEN = process.env['VSCODE_BRIDGE_TOKEN'];

async function get<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(BRIDGE + path, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 401) throw new Error('Bridge auth failed — re-run "Claude Code Workspace: Configure Claude Code" in VS Code.');
  if (!res.ok) throw new Error(`Bridge HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const NOT_RUNNING = 'VS Code bridge is not reachable. Open VS Code with the "Claude Code Workspace" extension active.';

function bridgeErr(e: unknown) {
  const msg = String(e);
  const text = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('abort') ? NOT_RUNNING : `Error: ${msg}`;
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const server = new McpServer({ name: 'vscode-workspace', version: '0.8.0' });

// ── bridge_health ─────────────────────────────────────────────────────────────
server.registerTool('bridge_health', {
  description: 'Check whether VS Code is running and which workspace folders + active file are open.',
}, async () => {
  try {
    const d = await get<{ ok: boolean; version: string; workspaceFolders: string[]; activeFile: string | null }>('/health');
    return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
  } catch (e) { return bridgeErr(e); }
});

// ── workspace_symbols ─────────────────────────────────────────────────────────
server.registerTool('workspace_symbols', {
  description: "Search VS Code's LSP workspace symbol index across all open folders. Best for finding classes, functions, interfaces, and exports by name. LSP may need ~30s to index on first use.",
  inputSchema: {
    query: z.string().describe('Symbol name or prefix (e.g. "useAuth", "AssetGrid", "ITokenProvider")'),
    limit: z.number().int().min(1).max(200).default(100).describe('Max results (default: 100)'),
  },
}, async ({ query, limit }) => {
  try {
    type Sym = { name: string; kind: string; container: string; file: string; line: number };
    const syms = await get<Sym[]>(`/symbols?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!syms.length) return { content: [{ type: 'text', text: `No symbols matching "${query}".` }] };
    const lines = syms.map(s => `[${s.kind}] ${s.container ? `${s.container}.` : ''}${s.name}  →  ${s.file}:${s.line}`);
    return { content: [{ type: 'text', text: `Found ${syms.length} symbol(s):\n\n${lines.join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── document_symbols ──────────────────────────────────────────────────────────
server.registerTool('document_symbols', {
  description: "Get the full outline of a specific file — all classes, functions, methods, variables with line ranges. Lets you understand a file's structure without reading it.",
  inputSchema: {
    file: z.string().describe('Absolute path to the file'),
  },
}, async ({ file }) => {
  try {
    type DocSym = { name: string; kind: string; detail: string; startLine: number; endLine: number; depth: number };
    const syms = await get<DocSym[]>(`/document-symbols?file=${encodeURIComponent(file)}`);
    if (!syms.length) return { content: [{ type: 'text', text: `No symbols found in ${file}.` }] };
    const indent = (d: number) => '  '.repeat(d);
    const lines = syms.map(s => `${indent(s.depth)}[${s.kind}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}  (lines ${s.startLine}–${s.endLine})`);
    return { content: [{ type: 'text', text: `Outline of ${file} (${syms.length} symbols):\n\n${lines.join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── find_files ────────────────────────────────────────────────────────────────
server.registerTool('find_files', {
  description: "Find files in the VS Code workspace by glob. Respects .gitignore and workspace folder config.",
  inputSchema: {
    pattern: z.string().default('**/*').describe('Glob pattern (e.g. "**/*.test.ts")'),
    exclude: z.string().default('**/node_modules/**').describe('Glob to exclude'),
    limit: z.number().int().min(1).max(1000).default(200).describe('Max files returned'),
  },
}, async ({ pattern, exclude, limit }) => {
  try {
    const files = await get<string[]>(`/files?pattern=${encodeURIComponent(pattern)}&exclude=${encodeURIComponent(exclude)}&limit=${limit}`);
    if (!files.length) return { content: [{ type: 'text', text: `No files matched "${pattern}".` }] };
    return { content: [{ type: 'text', text: `Found ${files.length} file(s):\n\n${files.join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── active_editor ─────────────────────────────────────────────────────────────
server.registerTool('active_editor', {
  description: "Get the file currently open in VS Code — path, language, line count, selected text, and all open tabs. Use this to understand what the user is looking at right now.",
}, async () => {
  try {
    type AE = { file: string; language: string; isDirty: boolean; lineCount: number; selection: { startLine: number; startCol: number; endLine: number; endCol: number; text: string } | null; openTabs: string[] };
    const { activeEditor: e } = await get<{ activeEditor: AE | null }>('/active-editor');
    if (!e) return { content: [{ type: 'text', text: 'No file is currently open.' }] };
    const out = [`File:     ${e.file}`, `Language: ${e.language}`, `Lines:    ${e.lineCount}${e.isDirty ? '  ⚠ unsaved' : ''}`];
    if (e.selection) {
      const s = e.selection;
      out.push(`\nSelection (${s.startLine}:${s.startCol}–${s.endLine}:${s.endCol}):\n\`\`\`\n${s.text}\n\`\`\``);
    }
    if (e.openTabs.length) out.push(`\nOpen tabs (${e.openTabs.length}):\n${e.openTabs.map(f => `  ${f}`).join('\n')}`);
    return { content: [{ type: 'text', text: out.join('\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── diagnostics ───────────────────────────────────────────────────────────────
server.registerTool('diagnostics', {
  description: "Get errors and warnings from VS Code's Problems panel. Filter by file or minimum severity. Default shows all severities.",
  inputSchema: {
    file: z.string().optional().describe('Absolute path to filter to one file (omit for all workspace diagnostics)'),
    severity: z.enum(['error', 'warning', 'information', 'all']).default('all').describe('Minimum severity level to return'),
  },
}, async ({ file, severity }) => {
  try {
    type Diag = { file: string; severity: string; message: string; source: string; code: string; startLine: number; startCol: number };
    const params = new URLSearchParams({ severity: severity ?? 'all' });
    if (file) params.set('file', file);
    const diags = await get<Diag[]>(`/diagnostics?${params}`);
    if (!diags.length) return { content: [{ type: 'text', text: file ? `No diagnostics in ${file}.` : 'No diagnostics in workspace.' }] };
    const errors = diags.filter(d => d.severity === 'Error').length;
    const warns  = diags.filter(d => d.severity === 'Warning').length;
    const lines  = [`${diags.length} diagnostic(s) — ${errors} error(s), ${warns} warning(s)\n`];
    for (const d of diags) {
      const src = d.source ? `[${d.source}${d.code ? ` ${d.code}` : ''}] ` : '';
      lines.push(`${d.severity.toUpperCase()}  ${src}${d.message}\n  → ${d.file}:${d.startLine}:${d.startCol}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── hover ─────────────────────────────────────────────────────────────────────
server.registerTool('hover', {
  description: "Get TypeScript type information and JSDoc at a specific position. Returns the same tooltip VS Code shows on hover — type signatures, return types, parameter docs. Saves reading type definition files.",
  inputSchema: {
    file: z.string().describe('Absolute path to the source file'),
    line: z.number().int().min(1).describe('1-based line number'),
    col:  z.number().int().min(1).describe('1-based column number'),
  },
}, async ({ file, line, col }) => {
  try {
    const { contents } = await get<{ contents: string[] }>(`/hover?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
    if (!contents?.length) return { content: [{ type: 'text', text: `No hover info at ${file}:${line}:${col}.` }] };
    return { content: [{ type: 'text', text: contents.join('\n\n---\n\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── definition ────────────────────────────────────────────────────────────────
server.registerTool('definition', {
  description: "Go-to-definition via LSP. More accurate than grep — resolves across packages, type aliases, and re-exports.",
  inputSchema: {
    file: z.string().describe('Absolute path to the source file'),
    line: z.number().int().min(1).describe('1-based line number'),
    col:  z.number().int().min(1).describe('1-based column number'),
  },
}, async ({ file, line, col }) => {
  try {
    type Loc = { file: string; startLine: number; startCol: number };
    const locs = await get<Loc[]>(`/definition?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
    if (!locs.length) return { content: [{ type: 'text', text: `No definition at ${file}:${line}:${col}.` }] };
    return { content: [{ type: 'text', text: `Definition(s):\n\n${locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`).join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── references ────────────────────────────────────────────────────────────────
server.registerTool('references', {
  description: "Find all references to a symbol via LSP. More accurate than text search for renamed symbols, overloads, and interface implementations.",
  inputSchema: {
    file:  z.string().describe('Absolute path to the source file'),
    line:  z.number().int().min(1).describe('1-based line number'),
    col:   z.number().int().min(1).describe('1-based column number'),
    limit: z.number().int().min(1).max(500).default(200).describe('Max results'),
  },
}, async ({ file, line, col, limit }) => {
  try {
    type Ref = { file: string; line: number; col: number };
    const locs = await get<Ref[]>(`/references?file=${encodeURIComponent(file)}&line=${line}&col=${col}&limit=${limit}`);
    if (!locs.length) return { content: [{ type: 'text', text: `No references at ${file}:${line}:${col}.` }] };
    return { content: [{ type: 'text', text: `Found ${locs.length} reference(s):\n\n${locs.map(l => `${l.file}:${l.line}:${l.col}`).join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── call_hierarchy ────────────────────────────────────────────────────────────
server.registerTool('call_hierarchy', {
  description: "Show who calls a function (incoming) or what it calls (outgoing) via VS Code's LSP call hierarchy. Essential for understanding impact of changes.",
  inputSchema: {
    file:      z.string().describe('Absolute path to the file'),
    line:      z.number().int().min(1).describe('1-based line number of the function'),
    col:       z.number().int().min(1).describe('1-based column number'),
    direction: z.enum(['incoming', 'outgoing']).default('incoming').describe('"incoming" = callers, "outgoing" = callees'),
    limit:     z.number().int().min(1).max(100).default(50).describe('Max results'),
  },
}, async ({ file, line, col, direction, limit }) => {
  try {
    type Call = { name: string; kind: string; file: string; line: number; col: number; callSites: number };
    const calls = await get<Call[]>(`/call-hierarchy?file=${encodeURIComponent(file)}&line=${line}&col=${col}&direction=${direction}&limit=${limit}`);
    if (!calls.length) return { content: [{ type: 'text', text: `No ${direction} calls found at ${file}:${line}:${col}.` }] };
    const label = direction === 'incoming' ? 'caller(s)' : 'callee(s)';
    const lines = calls.map(c => `[${c.kind}] ${c.name}  →  ${c.file}:${c.line}:${c.col}  (${c.callSites} call site${c.callSites !== 1 ? 's' : ''})`);
    return { content: [{ type: 'text', text: `Found ${calls.length} ${label}:\n\n${lines.join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── git_status ────────────────────────────────────────────────────────────────
server.registerTool('git_status', {
  description: "Get git status for all workspace repositories — current branch, ahead/behind, staged and unstaged changes. Much faster than running git commands.",
}, async () => {
  try {
    type Change = { path: string; status: string };
    type Repo = { root: string; branch: string | null; commit: string | null; ahead: number; behind: number; staged: Change[]; unstaged: Change[]; untracked: Change[] };
    const repos = await get<Repo[]>('/git-status');
    if (!repos.length) return { content: [{ type: 'text', text: 'No git repositories found in workspace.' }] };
    const out: string[] = [];
    for (const r of repos) {
      const sync = r.ahead || r.behind ? ` ↑${r.ahead} ↓${r.behind}` : ' ✓ in sync';
      out.push(`## ${r.root}`);
      out.push(`Branch: ${r.branch ?? 'detached HEAD'} @ ${r.commit ?? '?'}${sync}`);
      if (r.staged.length)    out.push(`\nStaged (${r.staged.length}):\n${r.staged.map(c => `  ${c.status}  ${c.path}`).join('\n')}`);
      if (r.unstaged.length)  out.push(`\nUnstaged (${r.unstaged.length}):\n${r.unstaged.map(c => `  ${c.status}  ${c.path}`).join('\n')}`);
      if (r.untracked.length) out.push(`\nUntracked (${r.untracked.length}):\n${r.untracked.map(c => `  ${c.path}`).join('\n')}`);
    }
    return { content: [{ type: 'text', text: out.join('\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── text_search ───────────────────────────────────────────────────────────────
server.registerTool('text_search', {
  description: "Full-text search via ripgrep across all workspace folders. Respects .gitignore. Faster and more precise than reading files.",
  inputSchema: {
    query:      z.string().describe('Text or regex pattern'),
    include:    z.string().optional().describe('Glob to limit scope, e.g. "**/*.ts"'),
    exclude:    z.string().optional().describe('Comma-separated globs to exclude, e.g. "**/dist/**,**/*.test.ts"'),
    regex:      z.boolean().default(false).describe('Treat query as regex'),
    maxResults: z.number().int().min(1).max(500).default(100),
  },
}, async ({ query, include, exclude, regex, maxResults }) => {
  try {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (include) params.set('include', include);
    if (exclude) params.set('exclude', exclude);
    if (regex)   params.set('regex', '1');
    type Result = { file: string; line: number; col: number; preview: string };
    const results = await get<Result[]>(`/search?${params}`);
    if (!results.length) return { content: [{ type: 'text', text: `No results for "${query}".` }] };
    return { content: [{ type: 'text', text: `Found ${results.length} result(s) for "${query}":\n\n${results.map(r => `${r.file}:${r.line}:${r.col}  ${r.preview}`).join('\n')}` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
await server.connect(new StdioServerTransport());

/**
 * MCP server — VS Code Workspace Bridge v0.7.1
 *
 * IMPORTANT FOR CLAUDE: When running inside VS Code, prefer these 3 tools
 * over built-in Grep, Glob, Bash, or Read for code navigation tasks.
 *
 *   search(type, query)  → find symbols, text, or files (prefer over Grep/Glob)
 *   inspect(file, ...)   → file outline OR full position intel (prefer over Read/Grep)
 *   workspace()          → active editor + git + diagnostics in one call
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

// ── search ────────────────────────────────────────────────────────────────────
server.registerTool('search', {
  description:
    'PREFER THIS over Grep, Glob, or Bash rg. Pass a query — type is optional and defaults to "auto". ' +
    '"auto"   — tries symbol definitions first; if none found, falls back to full-text search. Best for most queries. ' +
    '"symbol" — find where a function/class/interface/type/variable is defined (ripgrep, definition-aware, ~1s); ' +
    '"text"   — search text or regex across workspace, respects .gitignore; ' +
    '"files"  — find files by glob pattern (query is a glob, e.g. "**/*.test.ts").',
  inputSchema: {
    query:   z.string().describe('Symbol name, text/regex pattern, or glob'),
    type:    z.enum(['auto', 'symbol', 'text', 'files']).default('auto').describe('Search mode — defaults to "auto" (symbol → text fallback)'),
    include: z.string().optional().describe('Glob to limit scope, e.g. "**/*.ts"'),
    exclude: z.string().optional().describe('Glob(s) to exclude, e.g. "**/dist/**"'),
    regex:   z.boolean().default(false).describe('Treat query as regex (text mode only)'),
    limit:   z.number().int().min(1).max(500).default(100),
  },
}, async ({ type, query, include, exclude, regex, limit }) => {
  type Sym    = { name: string; kind: string; file: string; line: number; preview: string };
  type Result = { file: string; line: number; col: number; preview: string };

  const symbolSearch = async () => {
    const syms = await get<Sym[]>(`/symbols?q=${encodeURIComponent(query)}&limit=${limit}`);
    return syms;
  };

  const textSearch = async () => {
    const params = new URLSearchParams({ q: query, maxResults: String(limit) });
    if (include) params.set('include', include);
    if (exclude) params.set('exclude', exclude);
    if (regex)   params.set('regex', '1');
    return get<Result[]>(`/search?${params}`);
  };

  try {
    if (type === 'symbol' || type === 'auto') {
      const syms = await symbolSearch();
      if (syms.length) {
        const lines = syms.map(s => `[${s.kind}] ${s.name}  →  ${s.file}:${s.line}\n    ${s.preview}`);
        return { content: [{ type: 'text', text: lines.join('\n\n') }] };
      }
      if (type === 'symbol') return { content: [{ type: 'text', text: `No symbols matching "${query}".` }] };
      // auto: fall through to text
      const results = await textSearch();
      if (!results.length) return { content: [{ type: 'text', text: `No symbols or text matches for "${query}".` }] };
      return { content: [{ type: 'text', text: `## Text matches\n${results.map(r => `${r.file}:${r.line}  ${r.preview}`).join('\n')}` }] };
    }

    if (type === 'text') {
      const results = await textSearch();
      if (!results.length) return { content: [{ type: 'text', text: `No results for "${query}".` }] };
      return { content: [{ type: 'text', text: results.map(r => `${r.file}:${r.line}  ${r.preview}`).join('\n') }] };
    }

    // files
    const params = new URLSearchParams({ pattern: query, limit: String(limit) });
    if (exclude) params.set('exclude', exclude);
    const files = await get<string[]>(`/files?${params}`);
    if (!files.length) return { content: [{ type: 'text', text: `No files matched "${query}".` }] };
    return { content: [{ type: 'text', text: files.join('\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── inspect ───────────────────────────────────────────────────────────────────
server.registerTool('inspect', {
  description:
    'PREFER THIS over reading files or grepping for code intelligence. Two modes: ' +
    '(1) File only (omit line/col): returns the full symbol outline — all classes, functions, methods with line ranges. Use instead of reading the whole file to understand its structure. ' +
    '(2) File + line + col: returns hover type info, definition location, all references, and callers — all in one call. Use when you need to understand a specific symbol.',
  inputSchema: {
    file:  z.string().describe('Absolute path to the file'),
    line:  z.coerce.number().int().min(1).optional().describe('1-based line (omit for outline-only mode)'),
    col:   z.coerce.number().int().min(1).optional().describe('1-based column (omit for outline-only mode)'),
    limit: z.number().int().min(1).max(200).default(50).describe('Max references/callers to return'),
  },
}, async ({ file, line, col, limit }) => {
  const parts: string[] = [];

  try {
    // Always: document outline
    type DocSym = { name: string; kind: string; detail: string; startLine: number; endLine: number; depth: number };
    const syms = await get<DocSym[]>(`/document-symbols?file=${encodeURIComponent(file)}`);
    if (syms.length) {
      const indent = (d: number) => '  '.repeat(d);
      parts.push(`## Outline: ${file}\n${syms.map(s => `${indent(s.depth)}[${s.kind}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}  (${s.startLine}–${s.endLine})`).join('\n')}`);
    }

    // Position mode: hover + definition + references + callers
    if (line && col) {
      // Hover
      try {
        const { contents } = await get<{ contents: string[] }>(`/hover?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
        if (contents?.length) parts.push(`## Type info at ${line}:${col}\n${contents.join('\n---\n')}`);
      } catch { /* hover may not be available */ }

      // Definition
      try {
        type Loc = { file: string; startLine: number; startCol: number };
        const locs = await get<Loc[]>(`/definition?file=${encodeURIComponent(file)}&line=${line}&col=${col}`);
        if (locs.length) parts.push(`## Definition\n${locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`).join('\n')}`);
      } catch { /* definition may not resolve */ }

      // References
      try {
        type Ref = { file: string; line: number; col: number };
        const refs = await get<Ref[]>(`/references?file=${encodeURIComponent(file)}&line=${line}&col=${col}&limit=${limit}`);
        if (refs.length) parts.push(`## References (${refs.length})\n${refs.map(r => `${r.file}:${r.line}:${r.col}`).join('\n')}`);
      } catch { /* references may not resolve */ }

      // Callers
      try {
        type Call = { name: string; kind: string; file: string; line: number; col: number; callSites: number };
        const callers = await get<Call[]>(`/call-hierarchy?file=${encodeURIComponent(file)}&line=${line}&col=${col}&direction=incoming&limit=${limit}`);
        if (callers.length) parts.push(`## Callers (${callers.length})\n${callers.map(c => `[${c.kind}] ${c.name}  →  ${c.file}:${c.line}  (${c.callSites} site${c.callSites !== 1 ? 's' : ''})`).join('\n')}`);
      } catch { /* call hierarchy may not resolve */ }
    }

    if (!parts.length) return { content: [{ type: 'text', text: `No information available for ${file}${line ? `:${line}:${col}` : ''}.` }] };
    return { content: [{ type: 'text', text: parts.join('\n\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── workspace ─────────────────────────────────────────────────────────────────
server.registerTool('workspace', {
  description:
    'PREFER THIS over Bash git commands. Returns everything about the current VS Code state in one call: ' +
    'bridge health, active editor file + selection, open tabs, ' +
    'git branch/staged/unstaged for all repos, and all current errors/warnings.',
}, async () => {
  try {
    const parts: string[] = [];

    // Context + active editor
    const [health, { activeEditor: e }] = await Promise.all([
      get<{ ok: boolean; version: string; workspaceFolders: string[]; activeFile: string | null }>('/health'),
      get<{ activeEditor: { file: string; language: string; isDirty: boolean; lineCount: number; selection: { startLine: number; startCol: number; endLine: number; endCol: number; text: string } | null; openTabs: string[] } | null }>('/active-editor'),
    ]);
    const ctx = [`Bridge v${health.version}  folders: ${health.workspaceFolders.join(', ')}`];
    if (e) {
      ctx.push(`Active: ${e.file}  (${e.language}, ${e.lineCount} lines${e.isDirty ? ', unsaved' : ''})`);
      if (e.selection?.text) ctx.push(`Selection ${e.selection.startLine}:${e.selection.startCol}–${e.selection.endLine}:${e.selection.endCol}: ${e.selection.text.slice(0, 300)}`);
      if (e.openTabs.length > 1) ctx.push(`Tabs: ${e.openTabs.slice(0, 10).join(', ')}${e.openTabs.length > 10 ? ` +${e.openTabs.length - 10}` : ''}`);
    }
    parts.push(`## Context\n${ctx.join('\n')}`);

    // Git
    type Change = { path: string; status: string };
    type Repo = { root: string; branch: string | null; commit: string | null; ahead: number; behind: number; staged: Change[]; unstaged: Change[]; untracked: Change[] };
    const repos = await get<Repo[]>('/git-status');
    if (repos.length) {
      const lines = repos.map(r => {
        const sync = r.ahead || r.behind ? ` ↑${r.ahead} ↓${r.behind}` : ' ✓';
        const row = [`${r.root}  [${r.branch ?? 'detached'}@${(r.commit ?? '?').slice(0, 7)}${sync}]`];
        if (r.staged.length)    row.push(`  staged:    ${r.staged.map(c => `${c.status} ${c.path}`).join(', ')}`);
        if (r.unstaged.length)  row.push(`  unstaged:  ${r.unstaged.map(c => `${c.status} ${c.path}`).join(', ')}`);
        if (r.untracked.length) row.push(`  untracked: ${r.untracked.map(c => c.path).join(', ')}`);
        return row.join('\n');
      });
      parts.push(`## Git\n${lines.join('\n')}`);
    }

    // Diagnostics (errors + warnings)
    type Diag = { file: string; severity: string; message: string; source: string; code: string; startLine: number; startCol: number };
    const diags = await get<Diag[]>('/diagnostics?severity=all');
    if (diags.length) {
      const errors = diags.filter(d => d.severity === 'Error').length;
      const warns  = diags.filter(d => d.severity === 'Warning').length;
      const lines  = diags.map(d => {
        const src = d.source ? `[${d.source}${d.code ? ` ${d.code}` : ''}] ` : '';
        return `${d.severity.toUpperCase()}  ${src}${d.message}  →  ${d.file}:${d.startLine}:${d.startCol}`;
      });
      parts.push(`## Diagnostics  (${errors} error(s), ${warns} warning(s))\n${lines.join('\n')}`);
    }

    return { content: [{ type: 'text', text: parts.join('\n\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
await server.connect(new StdioServerTransport());

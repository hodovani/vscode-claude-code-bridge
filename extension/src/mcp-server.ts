/**
 * MCP server — VS Code Workspace Bridge v0.10.0
 *
 * IMPORTANT FOR CLAUDE: When running inside VS Code, prefer these 6 tools
 * over built-in Grep, Glob, Bash, or Read for code navigation tasks.
 *
 *   search(type, query)  → find symbols, text, or files (prefer over Grep/Glob)
 *   inspect(file, ...)   → file outline OR full position intel (prefer over Read/Grep)
 *   workspace()          → active editor + git + diagnostics in one call
 *   lsp_read(action, ..) → granular LSP read ops (type def, completions, inlay hints, etc.)
 *   refactor(action, ..) → LSP write ops: rename (preview/apply), code actions
 *   format(action, ..)   → document/range formatters, organize imports, fix-all
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

const server = new McpServer({ name: 'vscode-workspace', version: '0.10.0' });

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

// ── lsp_read ──────────────────────────────────────────────────────────────────
server.registerTool('lsp_read', {
  description:
    'Granular LSP read operations not covered by inspect/search. ' +
    '"type_definition" — go to the type that defines the symbol (e.g. the interface behind a variable); ' +
    '"implementation" — find concrete implementations of an interface or abstract method; ' +
    '"declaration" — go to the declaration (for languages that distinguish declaration from definition); ' +
    '"signature_help" — get parameter hints for the function call at the cursor; ' +
    '"completion" — get completion candidates at a position; ' +
    '"inlay_hints" — get inlay hint labels (type annotations, parameter names) for a line range; ' +
    '"document_highlights" — find all occurrences of a symbol within the current file.',
  inputSchema: {
    action:    z.enum(['type_definition', 'implementation', 'declaration', 'signature_help', 'completion', 'inlay_hints', 'document_highlights']),
    file:      z.string().describe('Absolute path to the file'),
    line:      z.coerce.number().int().min(1).optional().describe('1-based line (required for all except inlay_hints)'),
    col:       z.coerce.number().int().min(1).optional().describe('1-based column (required for all except inlay_hints)'),
    startLine: z.coerce.number().int().min(1).optional().describe('1-based start line (required for inlay_hints)'),
    endLine:   z.coerce.number().int().min(1).optional().describe('1-based end line (required for inlay_hints)'),
    limit:     z.number().int().min(1).max(200).default(50).describe('Max completions to return (completion only)'),
  },
}, async ({ action, file, line, col, startLine, endLine, limit }) => {
  try {
    if (action === 'type_definition') {
      const params = new URLSearchParams({ file, line: String(line ?? 1), col: String(col ?? 1) });
      type Loc = { file: string; startLine: number; startCol: number };
      const locs = await get<Loc[]>(`/type-definition?${params}`);
      if (!locs.length) return { content: [{ type: 'text', text: `No type definition at ${file}:${line}:${col}.` }] };
      return { content: [{ type: 'text', text: `## Type definition\n${locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`).join('\n')}` }] };
    }

    if (action === 'implementation') {
      const params = new URLSearchParams({ file, line: String(line ?? 1), col: String(col ?? 1) });
      type Loc = { file: string; startLine: number; startCol: number };
      const locs = await get<Loc[]>(`/implementation?${params}`);
      if (!locs.length) return { content: [{ type: 'text', text: `No implementations at ${file}:${line}:${col}.` }] };
      return { content: [{ type: 'text', text: `## Implementations (${locs.length})\n${locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`).join('\n')}` }] };
    }

    if (action === 'declaration') {
      const params = new URLSearchParams({ file, line: String(line ?? 1), col: String(col ?? 1) });
      type Loc = { file: string; startLine: number; startCol: number };
      const locs = await get<Loc[]>(`/declaration?${params}`);
      if (!locs.length) return { content: [{ type: 'text', text: `No declaration at ${file}:${line}:${col}.` }] };
      return { content: [{ type: 'text', text: `## Declaration\n${locs.map(l => `${l.file}:${l.startLine}:${l.startCol}`).join('\n')}` }] };
    }

    if (action === 'signature_help') {
      const params = new URLSearchParams({ file, line: String(line ?? 1), col: String(col ?? 1) });
      type SigHelp = { signatures: { label: string; documentation: string; parameters: { label: string; documentation: string }[] }[]; activeSignature: number; activeParameter: number } | null;
      const sh = await get<SigHelp>(`/signature-help?${params}`);
      if (!sh || !sh.signatures.length) return { content: [{ type: 'text', text: `No signature help at ${file}:${line}:${col}.` }] };
      const sig = sh.signatures[sh.activeSignature ?? 0];
      const lines = [`## Signature help at ${line}:${col}`, `\`${sig.label}\``];
      if (sig.documentation) lines.push(sig.documentation);
      if (sig.parameters.length) {
        lines.push(`\nParameters (active: ${sh.activeParameter ?? 0}):`);
        sig.parameters.forEach((p, i) => lines.push(`  ${i === (sh.activeParameter ?? 0) ? '>' : ' '} ${p.label}${p.documentation ? ` — ${p.documentation}` : ''}`));
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (action === 'completion') {
      const params = new URLSearchParams({ file, line: String(line ?? 1), col: String(col ?? 1), limit: String(limit) });
      type CompItem = { label: string; kind: string; detail: string; documentation: string; insertText: string; sortText: string };
      const items = await get<CompItem[]>(`/completion?${params}`);
      if (!items.length) return { content: [{ type: 'text', text: `No completions at ${file}:${line}:${col}.` }] };
      const text = `## Completions at ${line}:${col} (${items.length})\n` +
        items.map(i => `[${i.kind}] ${i.label}${i.detail ? `  — ${i.detail}` : ''}${i.documentation ? `\n    ${i.documentation.slice(0, 120)}` : ''}`).join('\n');
      return { content: [{ type: 'text', text }] };
    }

    if (action === 'inlay_hints') {
      const params = new URLSearchParams({ file, startLine: String(startLine ?? 1), endLine: String(endLine ?? startLine ?? 1) });
      type Hint = { line: number; col: number; label: string; kind: string; paddingLeft: boolean; paddingRight: boolean };
      const hints = await get<Hint[]>(`/inlay-hints?${params}`);
      if (!hints.length) return { content: [{ type: 'text', text: `No inlay hints in ${file} lines ${startLine}–${endLine}.` }] };
      const text = `## Inlay hints (${hints.length})\n` +
        hints.map(h => `L${h.line}:${h.col}  [${h.kind}] ${h.paddingLeft ? ' ' : ''}${h.label}${h.paddingRight ? ' ' : ''}`).join('\n');
      return { content: [{ type: 'text', text }] };
    }

    // document_highlights
    const params = new URLSearchParams({ file, line: String(line ?? 1), col: String(col ?? 1) });
    type Highlight = { startLine: number; startCol: number; endLine: number; endCol: number; kind: string };
    const highlights = await get<Highlight[]>(`/document-highlights?${params}`);
    if (!highlights.length) return { content: [{ type: 'text', text: `No highlights at ${file}:${line}:${col}.` }] };
    const text = `## Document highlights (${highlights.length})\n` +
      highlights.map(h => `L${h.startLine}:${h.startCol}–L${h.endLine}:${h.endCol}  [${h.kind}]`).join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (e) { return bridgeErr(e); }
});

// ── refactor ──────────────────────────────────────────────────────────────────
server.registerTool('refactor', {
  description:
    'LSP write operations: rename symbols and apply code actions. ' +
    '"rename" — rename a symbol across the workspace. Set apply=false (default) for a dry-run preview; apply=true to actually apply. ' +
    '"code_actions" — list available code actions (quick fixes, refactors) for a range. Returns a numbered list with index values. ' +
    '"apply_code_action" — apply a specific code action by its index from a prior code_actions call.',
  inputSchema: {
    action:      z.enum(['rename', 'code_actions', 'apply_code_action']),
    file:        z.string().describe('Absolute path to the file'),
    line:        z.coerce.number().int().min(1).describe('1-based line number'),
    col:         z.coerce.number().int().min(1).describe('1-based column number'),
    endLine:     z.coerce.number().int().min(1).optional().describe('1-based end line (code_actions range; defaults to line)'),
    endCol:      z.coerce.number().int().min(1).optional().describe('1-based end col (code_actions range; defaults to col)'),
    newName:     z.string().optional().describe('New name (required for rename)'),
    apply:       z.boolean().default(false).describe('For rename: false = preview only, true = apply edits'),
    kindFilter:  z.string().optional().describe('Code action kind filter, e.g. "quickfix" or "refactor"'),
    actionIndex: z.number().int().min(0).optional().describe('Index from prior code_actions call (required for apply_code_action)'),
  },
}, async ({ action, file, line, col, endLine, endCol, newName, apply, kindFilter, actionIndex }) => {
  try {
    if (action === 'rename') {
      if (!newName) return { content: [{ type: 'text', text: 'Error: newName is required for rename.' }], isError: true };
      const params = new URLSearchParams({ file, line: String(line), col: String(col), newName, apply: apply ? '1' : '0' });
      type RenameResult = { preview: { file: string; edits: { startLine: number; startCol: number; endLine: number; endCol: number; newText: string }[] }[]; applied: boolean };
      const result = await get<RenameResult>(`/rename?${params}`);
      if (!result.preview.length) return { content: [{ type: 'text', text: `No rename edits found at ${file}:${line}:${col}.` }] };

      const totalEdits = result.preview.reduce((sum, f) => sum + f.edits.length, 0);
      const fileCount = result.preview.length;
      const lines: string[] = [];

      if (apply) {
        lines.push(`Applied ${totalEdits} edit${totalEdits !== 1 ? 's' : ''} across ${fileCount} file${fileCount !== 1 ? 's' : ''}.`);
      } else {
        lines.push('## Rename preview (not applied)');
        for (const f of result.preview) {
          lines.push(`${f.file}:`);
          for (const e of f.edits) {
            lines.push(`  L${e.startLine}:${e.startCol}–L${e.endLine}:${e.endCol}  ${newName}`);
          }
        }
        lines.push('');
        lines.push('Re-run with apply=true to apply.');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (action === 'code_actions') {
      const resolvedEndLine = endLine ?? line;
      const resolvedEndCol  = endCol  ?? col;
      const params = new URLSearchParams({ file, startLine: String(line), startCol: String(col), endLine: String(resolvedEndLine), endCol: String(resolvedEndCol) });
      if (kindFilter) params.set('kindFilter', kindFilter);
      type ActionItem = { title: string; kind: string; isPreferred: boolean; index: number };
      const actions = await get<ActionItem[]>(`/code-actions?${params}`);
      if (!actions.length) return { content: [{ type: 'text', text: `No code actions at ${file}:${line}:${col}.` }] };
      const text = `## Code actions (${actions.length})\n` +
        actions.map(a => `[${a.index}] ${a.title}${a.kind ? ` (${a.kind})` : ''}${a.isPreferred ? '  ★ preferred' : ''}`).join('\n');
      return { content: [{ type: 'text', text }] };
    }

    // apply_code_action
    if (actionIndex === undefined || actionIndex === null) {
      return { content: [{ type: 'text', text: 'Error: actionIndex is required for apply_code_action.' }], isError: true };
    }
    const resolvedEndLine = endLine ?? line;
    const resolvedEndCol  = endCol  ?? col;
    const params = new URLSearchParams({ file, startLine: String(line), startCol: String(col), endLine: String(resolvedEndLine), endCol: String(resolvedEndCol), actionIndex: String(actionIndex) });
    if (kindFilter) params.set('kindFilter', kindFilter);
    type ApplyResult = { applied: boolean; title: string };
    const result = await get<ApplyResult>(`/apply-code-action?${params}`);
    if (!result.applied) return { content: [{ type: 'text', text: `Code action at index ${actionIndex} could not be applied (action may no longer exist).` }] };
    return { content: [{ type: 'text', text: `Applied: "${result.title}"` }] };
  } catch (e) { return bridgeErr(e); }
});

// ── format ────────────────────────────────────────────────────────────────────
server.registerTool('format', {
  description:
    'Whole-file or range formatters and workspace-wide auto-fixes. ' +
    'action=format — run the registered document formatter (Prettier, gofmt, Black, …); ' +
    'action=format_range — same, scoped to a range; ' +
    'action=organize_imports — apply VS Code\'s "Organize imports" code action; ' +
    'action=fix_all — apply all "source.fixAll" code actions (TS auto-fixes, etc.). ' +
    'apply=false returns a preview; apply=true mutates the file. ' +
    'PREFER THIS over manually rewriting indentation, sorting imports by hand, or running prettier/eslint --fix in Bash.',
  inputSchema: {
    action:    z.enum(['format', 'format_range', 'organize_imports', 'fix_all']),
    file:      z.string().describe('Absolute path to the file'),
    startLine: z.coerce.number().int().min(1).optional().describe('1-based start line (format_range only)'),
    startCol:  z.coerce.number().int().min(1).optional().describe('1-based start col (format_range only)'),
    endLine:   z.coerce.number().int().min(1).optional().describe('1-based end line (format_range only)'),
    endCol:    z.coerce.number().int().min(1).optional().describe('1-based end col (format_range only)'),
    apply:     z.boolean().default(false).describe('false (default) = preview edits; true = apply + save'),
  },
}, async ({ action, file, startLine, startCol, endLine, endCol, apply }) => {
  try {
    type EditItem = { startLine: number; startCol: number; endLine: number; endCol: number; newText: string };
    type FileEdits = { file: string; edits: EditItem[] };
    type FormatResult = { preview: FileEdits[]; applied: boolean | number; saved: number; commandOnly?: boolean };

    const truncate = (s: string, n: number) => s.length <= n ? s : s.slice(0, n) + '…';

    const endpoint = action === 'format_range' ? 'format-range'
      : action === 'organize_imports' ? 'organize-imports'
      : action === 'fix_all' ? 'fix-all'
      : 'format';
    const params = new URLSearchParams({ file, apply: apply ? '1' : '0' });
    if (action === 'format_range') {
      if (startLine) params.set('startLine', String(startLine));
      if (startCol)  params.set('startCol',  String(startCol));
      if (endLine)   params.set('endLine',   String(endLine));
      if (endCol)    params.set('endCol',    String(endCol));
    }
    const result = await get<FormatResult>(`/${endpoint}?${params}`);

    if (apply) {
      const editCount = result.preview.reduce((s, f) => s + f.edits.length, 0);
      const fileCount = result.preview.length;
      return { content: [{ type: 'text', text: `Applied ${editCount} edit${editCount !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}. Saved ${result.saved} file${result.saved !== 1 ? 's' : ''}.` }] };
    }

    const totalEdits = result.preview.reduce((s, f) => s + f.edits.length, 0);
    const fileCount = result.preview.length;
    if (totalEdits === 0) {
      const note = result.commandOnly ? ' (command-only action, no text preview available)' : '';
      return { content: [{ type: 'text', text: `No edits to preview${note}.` }] };
    }
    const lines: string[] = [`## Format preview (${totalEdits} edit${totalEdits !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''})`];
    for (const f of result.preview) {
      for (const e of f.edits) {
        lines.push(`${f.file}  L${e.startLine}:${e.startCol}–L${e.endLine}:${e.endCol}  →  ${JSON.stringify(truncate(e.newText, 60))}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) { return bridgeErr(e); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
await server.connect(new StdioServerTransport());

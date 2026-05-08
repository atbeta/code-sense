import Parser, { type SyntaxNode } from 'web-tree-sitter';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync, readFileSync } from 'node:fs';

let parserInitialized = false;
let jsParser: Parser | null = null;
let tsParser: Parser | null = null;

export type SourceLanguage = 'js' | 'ts';

/**
 * Initialize the web-tree-sitter parser with JavaScript and TypeScript grammars.
 * Must be called once before any parsing.
 */
export async function initParser(): Promise<void> {
  if (parserInitialized) return;

  await Parser.init();

  // Load JavaScript grammar
  const jsWasmPath = resolveWasmPath('tree-sitter-javascript.wasm');
  const jsLang = await loadWasm(jsWasmPath, 'tree-sitter-javascript.wasm');
  jsParser = new Parser();
  jsParser.setLanguage(jsLang);

  // Load TypeScript grammar
  const tsWasmPath = resolveWasmPath('tree-sitter-typescript.wasm');
  const tsLang = await loadWasm(tsWasmPath, 'tree-sitter-typescript.wasm');
  tsParser = new Parser();
  tsParser.setLanguage(tsLang);

  parserInitialized = true;
}

function resolveWasmPath(filename: string): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(__dirname, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out', filename),
    resolve(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', filename),
  ];
  for (const p of candidates) {
    try {
      statSync(p);
      return p;
    } catch {
      // not found
    }
  }
  return candidates[1];
}

/** WASM magic bytes: \0asm */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/** Minimum expected WASM sizes (in bytes) for cursory validation */
const EXPECTED_SIZES: Record<string, number> = {
  'tree-sitter-javascript.wasm': 600_000, // ~632KB
  'tree-sitter-typescript.wasm': 2_200_000, // ~2.2MB
};

async function loadWasm(filePath: string, filename: string): Promise<Parser.Language> {
  const buf = readFileSync(filePath);

  // Validate WASM magic bytes
  if (!buf.subarray(0, 4).equals(WASM_MAGIC)) {
    throw new Error(
      `[CodeSense] Invalid WASM file: ${filename} at ${filePath}\n` +
        `  File does not start with WASM magic bytes (\\0asm).\n` +
        `  The file may be corrupted. Try: npm ci --force && npx codesense index`,
    );
  }

  // Validate minimum size (catches truncated downloads)
  const minSize = EXPECTED_SIZES[filename];
  if (minSize && buf.length < minSize) {
    throw new Error(
      `[CodeSense] Truncated WASM file: ${filename}\n` +
        `  Expected at least ${minSize} bytes, got ${buf.length} bytes.\n` +
        `  The file was likely incompletely downloaded.\n` +
        `  Fix: rm -rf node_modules/tree-sitter-wasms && npm install`,
    );
  }

  try {
    return await Parser.Language.load(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('WebAssembly') || msg.includes('CompileError')) {
      throw new Error(
        `[CodeSense] Failed to compile WASM: ${filename}\n` +
          `  ${msg}\n` +
          `  This usually means the WASM binary is corrupted or incompatible.\n` +
          `  Fix: rm -rf node_modules/tree-sitter-wasms && pnpm install`,
        { cause: err },
      );
    }
    throw new Error(`Failed to load WASM: ${filename}`, { cause: err });
  }
}

export function getParser(lang?: SourceLanguage): Parser {
  const parser = lang === 'ts' ? tsParser : jsParser;
  if (!parser) {
    throw new Error('Parser not initialized. Call initParser() first.');
  }
  return parser;
}

/** Detects whether a file should use TypeScript parser based on extension and SFC script lang */
export function detectLanguage(filePath: string, sfcScriptLang?: string): SourceLanguage {
  if (sfcScriptLang === 'ts' || sfcScriptLang === 'tsx') return 'ts';
  if (/\.(ts|tsx)$/i.test(filePath)) return 'ts';
  return 'js';
}

export function parseSource(source: string, lang: SourceLanguage = 'js') {
  const parser = getParser(lang);
  return parser.parse(source);
}

// === Tree traversal utilities ===

export type NodePredicate = (node: SyntaxNode) => boolean;
export type NodeVisitor = (node: SyntaxNode) => void;

export function walk(root: SyntaxNode, predicate: NodePredicate, visitor: NodeVisitor): void {
  const visited = new Set<number>();

  function visit(node: SyntaxNode): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    if (predicate(node)) {
      visitor(node);
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);
}

export function collect(root: SyntaxNode, predicate: NodePredicate): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  walk(root, predicate, (node) => results.push(node));
  return results;
}

// === Common predicates ===

export const isImportStatement: NodePredicate = (node) => node.type === 'import_statement';

export const isCallExpression: NodePredicate = (node) => node.type === 'call_expression';

export const isNewExpression: NodePredicate = (node) => node.type === 'new_expression';

export const isMemberExpression: NodePredicate = (node) => node.type === 'member_expression';

export const isExportStatement: NodePredicate = (node) => node.type === 'export_statement';

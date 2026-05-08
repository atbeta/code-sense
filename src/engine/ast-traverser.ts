import Parser, { type SyntaxNode } from 'web-tree-sitter';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

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
  const jsLang = await Parser.Language.load(jsWasmPath);
  jsParser = new Parser();
  jsParser.setLanguage(jsLang);

  // Load TypeScript grammar
  const tsWasmPath = resolveWasmPath('tree-sitter-typescript.wasm');
  const tsLang = await Parser.Language.load(tsWasmPath);
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

export function getParser(lang?: SourceLanguage): Parser {
  const parser = lang === 'ts' ? tsParser : jsParser;
  if (!parser) {
    throw new Error(
      'Parser not initialized. Call initParser() first.',
    );
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

export function walk(
  root: SyntaxNode,
  predicate: NodePredicate,
  visitor: NodeVisitor,
): void {
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

export function collect(
  root: SyntaxNode,
  predicate: NodePredicate,
): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  walk(root, predicate, (node) => results.push(node));
  return results;
}

// === Common predicates ===

export const isImportStatement: NodePredicate = (node) =>
  node.type === 'import_statement';

export const isCallExpression: NodePredicate = (node) =>
  node.type === 'call_expression';

export const isNewExpression: NodePredicate = (node) =>
  node.type === 'new_expression';

export const isMemberExpression: NodePredicate = (node) =>
  node.type === 'member_expression';

export const isExportStatement: NodePredicate = (node) =>
  node.type === 'export_statement';

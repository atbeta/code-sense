/**
 * Vue Plugin — Function Classification
 *
 * Classifies functions/methods detected by tree-sitter into framework-aware kinds:
 * - composable_function (useXxx naming convention)
 * - store_action (inside Pinia/Vuex stores)
 * - store_mutation (Vuex mutations)
 * - function / method (generic)
 */
import type { SyntaxNode } from 'web-tree-sitter';
import type { FunctionExtractionContext, FunctionExtractionResult } from '../../types.js';
import { collect } from '../../../engine/ast-traverser.js';

export function classifyVueFunctions(ctx: FunctionExtractionContext): FunctionExtractionResult {
  const result: FunctionExtractionResult = { functions: [] };
  const seen = new Set<string>();

  function addFn(
    name: string,
    kind: FunctionExtractionResult['functions'][0]['kind'],
    startLine: number,
    endLine: number,
    node: SyntaxNode,
  ): void {
    const id = `${ctx.filePath}#${name}:${startLine}`;
    if (seen.has(id)) return;
    seen.add(id);

    const content = node.text.length > 300 ? node.text.substring(0, 300) + '...' : node.text;
    result.functions.push({
      id,
      name,
      filePath: ctx.filePath,
      entityPath: ctx.filePath,
      kind,
      startLine,
      endLine,
      content,
    });
  }

  const root = ctx.astRoot;
  const entityType = ctx.entityType;

  // function_declaration
  for (const node of collect(root, (n) => n.type === 'function_declaration')) {
    const name = node.childForFieldName('name')?.text;
    if (!name || (name.startsWith('_') && name.length > 1)) continue;
    const isComposable = /^use[A-Z]/.test(name);
    const kind = isComposable
      ? 'composable_function'
      : entityType === 'store'
        ? 'store_action'
        : 'function';
    addFn(name, kind, node.startPosition.row + 1, node.endPosition.row + 1, node);
  }

  // const foo = () => { ... } or const foo = function() { ... }
  for (const decl of collect(root, (n) => n.type === 'lexical_declaration')) {
    for (const child of decl.namedChildren) {
      if (child.type !== 'variable_declarator') continue;
      const nameNode = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (!nameNode || !valueNode) continue;
      const name = nameNode.text;
      const isArrow = valueNode.type === 'arrow_function';
      const isFuncExpr = valueNode.type === 'function';
      if (!isArrow && !isFuncExpr) continue;
      if (name.startsWith('_') && name.length > 1) continue;

      const isComposable = /^use[A-Z]/.test(name);
      const kind = isComposable
        ? 'composable_function'
        : entityType === 'store'
          ? 'store_action'
          : 'function';
      addFn(name, kind, child.startPosition.row + 1, child.endPosition.row + 1, child);
    }
  }

  // Options API methods
  for (const exp of collect(
    root,
    (n) => n.type === 'export_statement' && n.text.includes('default'),
  )) {
    for (const obj of collect(exp, (n) => n.type === 'object')) {
      for (const pair of obj.namedChildren) {
        if (pair.type !== 'pair') continue;
        const key = pair.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
        if (key !== 'methods') continue;
        const value = pair.childForFieldName('value');
        if (!value || value.type !== 'object') continue;

        for (const method of value.namedChildren) {
          if (method.type === 'pair') {
            const methodKey = method.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
            const methodBody = method.childForFieldName('value');
            if (!methodKey || !methodBody) continue;
            if (methodBody.type === 'arrow_function' || methodBody.type === 'function') {
              addFn(
                methodKey,
                'method',
                methodBody.startPosition.row + 1,
                methodBody.endPosition.row + 1,
                methodBody,
              );
            }
          }
          if (method.type === 'method_definition') {
            const methodName = method.childForFieldName('name')?.text;
            if (!methodName) continue;
            addFn(
              methodName,
              'method',
              method.startPosition.row + 1,
              method.endPosition.row + 1,
              method,
            );
          }
        }
      }

      // Computed properties
      for (const pair of obj.namedChildren) {
        if (pair.type !== 'pair') continue;
        const key = pair.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
        if (key !== 'computed') continue;
        const value = pair.childForFieldName('value');
        if (!value || value.type !== 'object') continue;
        for (const comp of value.namedChildren) {
          if (comp.type === 'pair') {
            const compKey = comp.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
            const compBody = comp.childForFieldName('value');
            if (!compKey || !compBody) continue;
            if (compBody.type === 'arrow_function' || compBody.type === 'function') {
              addFn(
                compKey,
                'method',
                compBody.startPosition.row + 1,
                compBody.endPosition.row + 1,
                compBody,
              );
            }
          }
        }
      }
    }
  }

  return result;
}

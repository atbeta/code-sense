import type { SyntaxNode } from 'web-tree-sitter';
import type { EntityExtractionResult } from '../../types.js';
import { collect } from '../../../engine/ast-traverser.js';

interface StoreInternals {
  state: string[];
  getters: string[];
  mutations: string[];
  actions: string[];
}

interface StoreItemUsage {
  itemName: string;
  itemType?: 'state' | 'getter' | 'action' | 'mutation';
  storeAlias?: string;
  storeName?: string;
  line: number;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

export function detectStoreUsage(root: SyntaxNode, props: Record<string, unknown>): void {
  const storeCalls = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      (n.childForFieldName('function')?.text?.startsWith('use') ?? false),
  );
  if (storeCalls.length > 0) {
    props.usesStore = true;
    props.storeCalls = storeCalls.map((n) => n.childForFieldName('function')?.text ?? '');
  }
}

export function detectStoreItemUsage(root: SyntaxNode, props: Record<string, unknown>): void {
  const usages: StoreItemUsage[] = [];
  const storeAliases = collectStoreAliases(root);

  for (const member of collect(root, (n) => n.type === 'member_expression')) {
    const object = member.childForFieldName('object')?.text;
    const property = member.childForFieldName('property')?.text;
    if (!object || !property) continue;

    const storeName = storeAliases.get(object);
    if (!storeName) continue;

    usages.push({
      itemName: property,
      storeAlias: object,
      storeName,
      line: member.startPosition.row + 1,
      evidence: member.text,
      confidence: 'high',
    });
  }

  for (const call of collect(root, (n) => n.type === 'call_expression')) {
    const helper = call.childForFieldName('function')?.text ?? '';
    if (!['mapState', 'mapGetters', 'mapActions', 'mapMutations'].includes(helper)) continue;

    for (const usage of extractMapHelperStoreItems(call, helper)) {
      usages.push(usage);
    }
  }

  const unique = new Map<string, StoreItemUsage>();
  for (const usage of usages) {
    const key = `${usage.storeName ?? ''}:${usage.itemName}:${usage.line}:${usage.evidence}`;
    if (!unique.has(key)) unique.set(key, usage);
  }

  if (unique.size > 0) {
    props.usesStoreItems = true;
    props.storeItemUsages = [...unique.values()];
  }
}

export function detectMapHelpers(root: SyntaxNode, props: Record<string, unknown>): void {
  const mapCalls = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      ['mapState', 'mapActions', 'mapGetters', 'mapMutations'].includes(
        n.childForFieldName('function')?.text ?? '',
      ),
  );
  if (mapCalls.length > 0) {
    props.usesMapHelpers = true;
    props.mapHelperCalls = mapCalls.map((n) => ({
      helper: n.childForFieldName('function')?.text ?? '',
      args: n.childForFieldName('arguments')?.text ?? '',
    }));
  }
}

export function extractStoreMetadata(
  root: SyntaxNode,
  props: Record<string, unknown>,
  storeItems: EntityExtractionResult['storeItems'],
): void {
  const internals = extractStoreInternals(root);
  props.hasState = internals.state.length > 0;
  props.hasGetters = internals.getters.length > 0;
  props.hasActions = internals.actions.length > 0;
  props.hasMutations = internals.mutations.length > 0;
  props.stateKeys = internals.state;
  props.getterNames = internals.getters;
  props.actionNames = internals.actions;
  props.mutationNames = internals.mutations;

  for (const stateName of internals.state) {
    storeItems.push({
      name: stateName,
      filePath: `${props.filePath || 'unknown'}#state:${stateName}`,
      type: 'state',
      properties: { kind: 'state', storePath: props.filePath || '' },
    });
  }
  for (const getterName of internals.getters) {
    storeItems.push({
      name: getterName,
      filePath: `${props.filePath || 'unknown'}#getter:${getterName}`,
      type: 'getter',
      properties: { kind: 'getter', storePath: props.filePath || '' },
    });
  }
  for (const actionName of internals.actions) {
    storeItems.push({
      name: actionName,
      filePath: `${props.filePath || 'unknown'}#action:${actionName}`,
      type: 'action',
      properties: { kind: 'action', storePath: props.filePath || '' },
    });
  }
  for (const mutationName of internals.mutations) {
    storeItems.push({
      name: mutationName,
      filePath: `${props.filePath || 'unknown'}#mutation:${mutationName}`,
      type: 'mutation',
      properties: { kind: 'mutation', storePath: props.filePath || '' },
    });
  }

  detectStoreVariant(root, props);
}

function collectStoreAliases(root: SyntaxNode): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const decl of collect(root, (n) => n.type === 'variable_declarator')) {
    const name = decl.childForFieldName('name')?.text;
    const value = decl.childForFieldName('value');
    if (!name || value?.type !== 'call_expression') continue;

    const callee = value.childForFieldName('function')?.text ?? '';
    const match = callee.match(/^use(.+)Store$/);
    if (!match) continue;

    aliases.set(name, match[1]);
  }
  return aliases;
}

function extractMapHelperStoreItems(call: SyntaxNode, helper: string): StoreItemUsage[] {
  const args = call.childForFieldName('arguments');
  if (!args) return [];

  const children = args.namedChildren;
  const moduleName = children
    .find((child) => child.type === 'string')
    ?.text.replace(/^['"]|['"]$/g, '');
  const itemType = mapHelperToStoreItemType(helper);
  const usages: StoreItemUsage[] = [];

  for (const child of children) {
    if (child.type === 'array') {
      for (const item of child.namedChildren) {
        if (item.type !== 'string') continue;
        const itemName = item.text.replace(/^['"]|['"]$/g, '');
        usages.push({
          itemName,
          itemType,
          storeName: moduleName,
          line: item.startPosition.row + 1,
          evidence: `${helper}(${args.text})`,
          confidence: moduleName ? 'high' : 'medium',
        });
      }
    }

    if (child.type === 'object') {
      for (const pair of child.namedChildren) {
        if (pair.type !== 'pair') continue;
        const value = pair.childForFieldName('value');
        if (!value) continue;
        const raw = value.text.replace(/^['"]|['"]$/g, '');
        const itemName = raw.includes('/') ? raw.split('/').pop()! : raw;
        const storeName = raw.includes('/') ? raw.split('/')[0] : moduleName;
        usages.push({
          itemName,
          itemType,
          storeName,
          line: pair.startPosition.row + 1,
          evidence: `${helper}(${args.text})`,
          confidence: storeName ? 'high' : 'medium',
        });
      }
    }
  }

  return usages;
}

function mapHelperToStoreItemType(helper: string): StoreItemUsage['itemType'] {
  if (helper === 'mapState') return 'state';
  if (helper === 'mapGetters') return 'getter';
  if (helper === 'mapActions') return 'action';
  if (helper === 'mapMutations') return 'mutation';
  return undefined;
}

function extractStoreInternals(root: SyntaxNode): StoreInternals {
  const result: StoreInternals = { state: [], getters: [], mutations: [], actions: [] };

  const defineStoreCalls = collect(
    root,
    (n) => n.type === 'call_expression' && n.childForFieldName('function')?.text === 'defineStore',
  );

  for (const callNode of defineStoreCalls) {
    const args = callNode.childForFieldName('arguments');
    if (!args) continue;
    for (const child of args.namedChildren) {
      if (child.type === 'object') {
        extractObjectKeys(child, result);
      } else if (child.type === 'arrow_function' || child.type === 'function') {
        const body = child.childForFieldName('body');
        if (body) {
          const returnStmts = collect(body, (n) => n.type === 'return_statement');
          for (const ret of returnStmts) {
            for (const retChild of ret.namedChildren) {
              if (retChild.type === 'object') {
                extractSetupStoreReturn(retChild, result, body);
              }
            }
          }
        }
      }
    }
  }

  extractVuexModuleVariables(root, result);

  if (result.state.length === 0 && result.getters.length === 0) {
    const objects = collect(root, (n) => n.type === 'object');
    for (const obj of objects) {
      extractObjectKeys(obj, result);
    }
  }

  result.state = [...new Set(result.state)];
  result.getters = [...new Set(result.getters)];
  result.mutations = [...new Set(result.mutations)];
  result.actions = [...new Set(result.actions)];

  return result;
}

function extractVuexModuleVariables(root: SyntaxNode, result: StoreInternals): void {
  const targetNames = new Set(['state', 'getters', 'mutations', 'actions']);

  for (const decl of collect(root, (n) => n.type === 'variable_declarator')) {
    const name = decl.childForFieldName('name')?.text;
    const value = decl.childForFieldName('value');
    if (!name || !targetNames.has(name) || value?.type !== 'object') continue;

    const keys = extractObjectPropertyKeys(value);
    if (name === 'state') result.state.push(...keys);
    if (name === 'getters') result.getters.push(...keys);
    if (name === 'mutations') result.mutations.push(...keys);
    if (name === 'actions') result.actions.push(...keys);
  }
}

function extractSetupStoreReturn(
  objNode: SyntaxNode,
  result: StoreInternals,
  bodyNode: SyntaxNode,
): void {
  for (const child of objNode.namedChildren) {
    if (child.type === 'pair' || child.type === 'shorthand_property_identifier') {
      const key = child.type === 'pair' ? child.childForFieldName('key')?.text : child.text;
      const value = child.type === 'pair' ? child.childForFieldName('value') : null;
      if (!key) continue;

      if (isSetupStoreRef(key, bodyNode)) result.state.push(key);
      else if (isSetupStoreComputed(key, bodyNode)) result.getters.push(key);
      else if (isSetupStoreFunction(key, bodyNode)) result.actions.push(key);
      else if (value) {
        const valText = value.text;
        if (valText.startsWith('ref(') || valText.startsWith('reactive(')) result.state.push(key);
        else if (valText.startsWith('computed(')) result.getters.push(key);
        else if (
          value.type === 'identifier' ||
          value.type === 'call_expression' ||
          value.type === 'arrow_function'
        ) {
          result.actions.push(key);
        }
      }
    }
  }
}

function isSetupStoreRef(name: string, bodyNode: SyntaxNode): boolean {
  return (
    collect(
      bodyNode,
      (n) =>
        (n.type === 'variable_declarator' || n.type === 'lexical_declaration') &&
        n.text.includes(name) &&
        (n.text.includes('ref(') || n.text.includes('reactive(')),
    ).length > 0
  );
}

function isSetupStoreComputed(name: string, bodyNode: SyntaxNode): boolean {
  return (
    collect(
      bodyNode,
      (n) =>
        (n.type === 'variable_declarator' || n.type === 'lexical_declaration') &&
        n.text.includes(name) &&
        n.text.includes('computed('),
    ).length > 0
  );
}

function isSetupStoreFunction(name: string, bodyNode: SyntaxNode): boolean {
  return (
    collect(
      bodyNode,
      (n) => n.type === 'function_declaration' && n.childForFieldName('name')?.text === name,
    ).length > 0
  );
}

function extractObjectKeys(objNode: SyntaxNode, result: StoreInternals): void {
  const knownKeys = new Set(['state', 'getters', 'mutations', 'actions']);
  for (const child of objNode.namedChildren) {
    if (child.type === 'pair') {
      const key = child.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
      const value = child.childForFieldName('value');
      if (!key || !value) continue;
      if (knownKeys.has(key) && value.type === 'object') {
        const keys = extractObjectPropertyKeys(value);
        if (key === 'state') result.state.push(...keys);
        if (key === 'getters') result.getters.push(...keys);
        if (key === 'mutations') result.mutations.push(...keys);
        if (key === 'actions') result.actions.push(...keys);
      }
    }
  }
}

function extractObjectPropertyKeys(objNode: SyntaxNode): string[] {
  const keys: string[] = [];
  for (const child of objNode.namedChildren) {
    if (child.type === 'pair') {
      const key = child.childForFieldName('key')?.text;
      if (key) keys.push(key.replace(/^['"]|['"]$/g, ''));
    }
    if (child.type === 'method_definition' || child.type === 'public_field_definition') {
      const name = child.childForFieldName('name')?.text;
      if (name) keys.push(name);
    }
  }
  return keys;
}

function detectStoreVariant(root: SyntaxNode, props: Record<string, unknown>): void {
  if (
    collect(
      root,
      (n) =>
        n.type === 'call_expression' && n.childForFieldName('function')?.text === 'defineStore',
    ).length > 0
  ) {
    props.variant = 'pinia';
  } else if (
    collect(root, (n) => n.type === 'new_expression' && n.text.includes('Store')).length > 0
  ) {
    props.variant = 'vuex';
  }
}

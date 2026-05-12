/**
 * Vue Plugin — Entity Extraction
 *
 * Extracts Vue-specific properties from source files:
 * - SFC script setup detection
 * - Options API vs Composition API
 * - Store internals (Pinia/Vuex state/getters/actions/mutations)
 * - Composable usage
 * - Component name
 * - Store variant
 * - Route entries
 */
import type { SyntaxNode } from 'web-tree-sitter';
import type { EntityExtractionContext, EntityExtractionResult } from '../../types.js';
import { parseSFC, extractScriptContent, type SFCBlock } from '../../../engine/sfc-parser.js';
import { parseSource, collect } from '../../../engine/ast-traverser.js';
import { extractMainIPC, extractRendererIPC, extractPreloadBridge } from './electron.js';

// ── Public API ──

export function extractVueEntity(ctx: EntityExtractionContext): EntityExtractionResult {
  const props: Record<string, unknown> = {};
  props.filePath = ctx.filePath; // needed for StoreItem primary key construction
  const apiUsage: EntityExtractionResult['apiUsage'] = [];
  const storeItems: EntityExtractionResult['storeItems'] = [];

  let astRoot = ctx.astRoot;
  let sfc: ReturnType<typeof parseSFC> | null;

  // SFC parsing for .vue files
  if (ctx.filePath.endsWith('.vue')) {
    sfc = parseSFC(ctx.source, ctx.filePath);
    props.isVue = true;
    props.usesScriptSetup = sfc.usesScriptSetup;

    if (sfc.mainScript) {
      const scriptLang =
        sfc.mainScript.attrs.includes('lang="ts"') || sfc.mainScript.attrs.includes("lang='ts'")
          ? ('ts' as const)
          : 'js';
      const scriptContent = extractScriptContent(sfc.mainScript);
      const tree = parseSource(scriptContent, scriptLang);
      astRoot = tree.rootNode;

      props.apiMode = detectApiMode(astRoot);
      extractComponentName(astRoot, props);
      detectStoreUsage(astRoot, props);
      detectStoreItemUsage(astRoot, props);
      detectMapHelpers(astRoot, props);
      detectComposableUsage(astRoot, props);
      detectMixins(astRoot, props);
      applyMarkers(props, sfc, ctx);
    }

    const template = sfc.blocks.find((b) => b.type === 'template');
    if (template) {
      const templateComponents = extractTemplateComponents(ctx.source, template);
      if (templateComponents.length > 0) {
        props.usesComponents = true;
        props.templateComponents = templateComponents;
      }
    }
  }

  // Framework API usage (works for both .vue and .js/.ts files)
  detectFrameworkApiUsage(astRoot, ctx, apiUsage);

  // Store internals (works for both .vue and .js/.ts store files)
  if (ctx.entityType === 'store') {
    extractStoreMetadata(astRoot, props, storeItems);
  }

  // Route file detection
  if (ctx.entityType === 'route') {
    detectRouter(astRoot, props);
  }

  // Electron main process: extract IPC handlers
  if (ctx.entityType === 'electron-main') {
    const handlers = extractMainIPC(astRoot);
    if (handlers.length > 0) {
      props.ipcHandlers = handlers;
      props.isElectronMain = true;
    }
  }

  // Preload script: extract bridge definition
  if (ctx.entityType === 'preload') {
    const bridge = extractPreloadBridge(astRoot);
    if (bridge) {
      props.preloadBridge = bridge;
      props.isPreload = true;
    }
  }

  // Components and renderer files: detect IPC calls
  if (ctx.entityType === 'component' || ctx.entityType === 'page' || ctx.entityType === 'layout') {
    const ipcCalls = extractRendererIPC(astRoot);
    if (ipcCalls.length > 0) {
      props.ipcCalls = ipcCalls;
      props.usesIPC = true;
    }
  }

  return { properties: props, apiUsage, storeItems };
}

// ── Template Component Usage ──

interface TemplateComponentUsage {
  tag: string;
  line: number;
}

const VUE_BUILTIN_TEMPLATE_TAGS = new Set([
  'component',
  'keep-alive',
  'router-link',
  'router-view',
  'slot',
  'suspense',
  'teleport',
  'transition',
  'transition-group',
]);

function extractTemplateComponents(source: string, template: SFCBlock): TemplateComponentUsage[] {
  const tags = new Map<string, number>();
  const tagRe = /<\s*([A-Za-z][A-Za-z0-9_.:-]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(template.content)) !== null) {
    const rawTag = match[1];
    const tag = rawTag.includes(':') ? rawTag.split(':').pop()! : rawTag;
    if (!isLikelyVueComponentTag(tag)) continue;
    if (!tags.has(tag)) {
      tags.set(tag, lineForIndex(source, template.startIndex + match.index));
    }
  }

  return [...tags.entries()].map(([tag, line]) => ({ tag, line }));
}

function isLikelyVueComponentTag(tag: string): boolean {
  const normalized = tag.toLowerCase();
  if (VUE_BUILTIN_TEMPLATE_TAGS.has(normalized)) return false;
  return /^[A-Z]/.test(tag) || tag.includes('-');
}

function lineForIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

// ── Detect API Mode ──

function detectApiMode(root: SyntaxNode): string {
  const compositionAPIs = ['ref', 'computed', 'watch', 'onMounted', 'reactive'];
  const hasSetup = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      compositionAPIs.includes(n.childForFieldName('function')?.text ?? ''),
  );
  const hasOptionsAPI = collect(
    root,
    (n) => n.type === 'export_statement' && n.text.includes('default'),
  );
  if (hasSetup.length > 0 && hasOptionsAPI.length > 0) return 'mixed';
  if (hasSetup.length > 0) return 'composition';
  if (hasOptionsAPI.length > 0) return 'options';
  return 'unknown';
}

// ── Component Name ──

function extractComponentName(root: SyntaxNode, props: Record<string, unknown>): void {
  const exportNodes = collect(
    root,
    (n) => n.type === 'export_statement' && n.text.includes('default'),
  );
  for (const node of exportNodes) {
    for (const child of node.namedChildren) {
      if (child.type === 'object' || child.type === 'object_literal') {
        for (const pair of child.namedChildren) {
          if (pair.type === 'pair') {
            const key = pair.childForFieldName('key');
            const value = pair.childForFieldName('value');
            if (key?.text === 'name' && value?.type === 'string') {
              const name = value.text.replace(/^['"]|['"]$/g, '');
              if (name) props.name = name;
              return;
            }
          }
        }
      }
    }
  }
}

// ── Store Usage ──

function detectStoreUsage(root: SyntaxNode, props: Record<string, unknown>): void {
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

interface StoreItemUsage {
  itemName: string;
  itemType?: 'state' | 'getter' | 'action' | 'mutation';
  storeAlias?: string;
  storeName?: string;
  line: number;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

function detectStoreItemUsage(root: SyntaxNode, props: Record<string, unknown>): void {
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

// ── Map Helpers (Vuex) ──

function detectMapHelpers(root: SyntaxNode, props: Record<string, unknown>): void {
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

// ── Composable Detection ──

function detectComposableUsage(root: SyntaxNode, props: Record<string, unknown>): void {
  const useCalls = collect(
    root,
    (n) =>
      n.type === 'call_expression' && /^use[A-Z]/.test(n.childForFieldName('function')?.text ?? ''),
  );
  if (useCalls.length > 0) {
    props.usesComposables = true;
    props.composableCalls = useCalls.map((n) => n.childForFieldName('function')?.text ?? '');
  }
}

// ── Mixin Detection ──

function detectMixins(root: SyntaxNode, props: Record<string, unknown>): void {
  const exportNodes = collect(
    root,
    (n) => n.type === 'export_statement' && n.text.includes('default'),
  );
  for (const node of exportNodes) {
    for (const obj of collect(node, (n) => n.type === 'object' || n.type === 'object_literal')) {
      for (const pair of obj.namedChildren) {
        if (pair.type !== 'pair') continue;
        const key = pair.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
        if (key !== 'mixins') continue;
        const value = pair.childForFieldName('value');
        if (!value || value.type !== 'array') continue;

        const mixinNames: string[] = [];
        for (const elem of value.namedChildren) {
          if (elem.type === 'identifier') {
            mixinNames.push(elem.text);
          }
        }
        if (mixinNames.length > 0) {
          props.usesMixins = true;
          props.mixinNames = mixinNames;
        }
      }
    }
  }
}

// ── Store Internals ──

interface StoreInternals {
  state: string[];
  getters: string[];
  mutations: string[];
  actions: string[];
}

function extractStoreMetadata(
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

  // Auto-detect store variant
  detectStoreVariant(root, props);
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

// ── Route Detection ──

function detectRouter(root: SyntaxNode, props: Record<string, unknown>): void {
  const routeDefs = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      (n.childForFieldName('function')?.text === 'createRouter' ||
        n.childForFieldName('function')?.text === 'new VueRouter'),
  );
  if (routeDefs.length > 0) {
    props.isRouter = true;
  }
  const routeEntries = extractRouteEntries(root);
  if (routeEntries.length > 0) {
    props.routes = routeEntries;
  }
}

interface RouteEntry {
  path?: string;
  name?: string;
  component?: string;
}

function extractRouteEntries(root: SyntaxNode): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const arrays = collect(root, (n) => n.type === 'array');
  for (const arr of arrays) {
    for (const child of arr.namedChildren) {
      if (child.type === 'object') {
        const entry: RouteEntry = {};
        for (const pair of child.namedChildren) {
          if (pair.type === 'pair') {
            const key = pair.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
            const value = pair.childForFieldName('value');
            if (key === 'path' && value?.type === 'string') {
              entry.path = value.text.replace(/^['"]|['"]$/g, '');
            } else if (key === 'name' && value?.type === 'string') {
              entry.name = value.text.replace(/^['"]|['"]$/g, '');
            } else if (key === 'component') {
              entry.component = value?.text;
            }
          }
        }
        if (entry.path || entry.name) routes.push(entry);
      }
    }
  }
  return routes;
}

// ── Framework API Detection ──

function detectFrameworkApiUsage(
  astRoot: SyntaxNode,
  ctx: EntityExtractionContext,
  apiUsage: EntityExtractionResult['apiUsage'],
): void {
  const config = ctx.config;
  if (!config.framework_apis?.length) return;

  // Build framework API map
  const frameworkAPIMap = new Map<string, string>();
  for (const fw of config.framework_apis) {
    for (const api of fw.api_list) {
      frameworkAPIMap.set(api, fw.name);
    }
  }

  const callNodes = collect(astRoot, (n) => n.type === 'call_expression');
  for (const node of callNodes) {
    const funcName = node.childForFieldName('function')?.text ?? '';
    if (frameworkAPIMap.has(funcName)) {
      apiUsage.push({
        fromFile: ctx.filePath,
        apiName: funcName,
        frameworkName: frameworkAPIMap.get(funcName)!,
      });
    }
  }

  // Compiler macros
  for (const fw of config.framework_apis) {
    if (fw.compiler_macros) {
      for (const macro of fw.compiler_macros) {
        const macroNodes = collect(
          astRoot,
          (n) => n.type === 'call_expression' && n.childForFieldName('function')?.text === macro,
        );
        for (const _ of macroNodes) {
          apiUsage.push({
            fromFile: ctx.filePath,
            apiName: macro,
            frameworkName: fw.name,
          });
        }
      }
    }
  }
}

// ── Entity Marker Application ──

function applyMarkers(
  props: Record<string, unknown>,
  sfc: ReturnType<typeof parseSFC> | null,
  ctx: EntityExtractionContext,
): void {
  const entityDef = ctx.config.all_entities[ctx.entityType];
  if (!entityDef?.markers) return;

  for (const marker of entityDef.markers) {
    if (marker.uses_options_api !== undefined && sfc) {
      props.usesOptionsAPI = marker.uses_options_api;
      const scriptContent = sfc.mainScript ? extractScriptContent(sfc.mainScript) : '';
      const scriptLang =
        sfc.mainScript?.attrs.includes('lang="ts"') || sfc.mainScript?.attrs.includes("lang='ts'")
          ? ('ts' as const)
          : 'js';
      const isOptions =
        detectApiMode(parseSource(scriptContent, scriptLang).rootNode) === 'options';
      if (marker.uses_options_api && isOptions) {
        props.markedAsOptionsAPI = true;
      }
    }
    if (marker.naming_pattern) {
      const name = (props.name as string) ?? '';
      const regex = new RegExp('^' + marker.naming_pattern.replace(/\*/g, '.*') + '$');
      props.matchesNamingPattern = regex.test(name);
    }
  }
}

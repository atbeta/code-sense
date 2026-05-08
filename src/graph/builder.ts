import { readFileSync, existsSync, rmSync } from 'node:fs';
import { basename, extname, resolve, dirname, join, sep } from 'node:path';
import type { SyntaxNode } from 'web-tree-sitter';
import type { ResolvedConfig } from '../types/config.js';
import type { EntityInstance, RelationInstance } from '../types/graph.js';
import { scanFiles } from '../engine/file-scanner.js';
import { parseSFC, extractScriptContent } from '../engine/sfc-parser.js';
import {
  initParser,
  parseSource,
  collect,
  isImportStatement,
  isCallExpression,
} from '../engine/ast-traverser.js';
import { getDetector } from '../engine/detectors/index.js';
import type { DetectorContext } from '../engine/detectors/base.js';
import { LbugGraph } from './lbug.js';
import { createSchema } from './schema.js';

export interface BuildResult {
  entities: EntityInstance[];
  relations: RelationInstance[];
  nodeCount: number;
  edgeCount: number;
}

export async function buildGraph(
  config: ResolvedConfig,
  sourceRoot: string,
  dbPath: string,
): Promise<BuildResult> {
  await initParser();

  // Clean existing database for fresh rebuild
  try { rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(dbPath + '.wal', { force: true }); } catch { /* ignore */ }

  const graph = new LbugGraph(dbPath);
  await createSchema(graph, config);

  const scanned = await scanFiles(config, sourceRoot);


  const entities: EntityInstance[] = [];
  const frameworkAPIUsage: { fromFile: string; apiName: string; frameworkName: string }[] = [];

  // Collect all framework API names for detection
  const frameworkAPIMap = new Map<string, string>(); // apiName → frameworkName
  for (const fw of config.framework_apis ?? []) {
    for (const api of fw.api_list) {
      frameworkAPIMap.set(api, fw.name);
    }
  }

  for (const file of scanned) {
    const result = await processFile(
      file.filePath,
      file.entityType,
      config,
      frameworkAPIMap,
    );
    if (result) {
      entities.push(result.entity);
      frameworkAPIUsage.push(...result.apiUsage);

      await graph.upsertEntity(
        (result.entity.properties.name as string) ??
          basename(result.entity.filePath, extname(result.entity.filePath)),
        result.entity.filePath,
        result.entity.type,
        result.entity.properties,
      );

      // Store internal items (state, getters, actions, mutations)
      for (const item of result.storeItems) {
        await graph.execute(
          `CREATE (s:StoreItem {name: '${escapeStr(item.name)}', filePath: '${escapeStr(item.filePath)}', itemType: '${escapeStr(item.type)}', storePath: '${escapeStr(result.entity.filePath)}', properties: '${escapeStr(JSON.stringify(item.properties))}'})`,
        );
        // Create has_item edge: Entity -> StoreItem
        await graph.execute(
          `MATCH (a:Entity {filePath: '${escapeStr(result.entity.filePath)}'}) MATCH (b:StoreItem {filePath: '${escapeStr(item.filePath)}'}) CREATE (a)-[:has_item]->(b)`,
        );
      }
    }
  }

  // Index framework API nodes
  for (const fw of config.framework_apis ?? []) {
    for (const apiName of fw.api_list) {
      try {
        await graph.execute(
          `CREATE (fw:FrameworkAPI {name: '${escapeStr(apiName)}'})`,
        );
      } catch {
        // node may already exist
      }
    }
  }

  // Create USES_API edges
  for (const usage of frameworkAPIUsage) {
    try {
      await graph.execute(
        `MATCH (a:Entity {filePath: '${escapeStr(usage.fromFile)}'}) MATCH (b:FrameworkAPI {name: '${escapeStr(usage.apiName)}'}) CREATE (a)-[:USES_API]->(b)`,
      );
    } catch {
      // target may not exist
    }
  }

  const relations: RelationInstance[] = [];

  // Auto-detected imports
  const importEdges = await buildImportEdges(entities, sourceRoot);

  for (const edge of importEdges) {
    relations.push(edge);
    try {
      await graph.createRel(edge.fromId, edge.toId, edge.type, edge.properties);
    } catch {
      // target may not exist
    }
  }

  // Config-defined relationships
  for (const [relType, relDef] of Object.entries(config.relationships ?? {})) {
    if (relType === 'imports') continue;

    const relEdges = await buildRelationshipEdges(
      relType,
      relDef,
      entities,
      config,
    );
    for (const edge of relEdges) {
      relations.push(edge);
      try {
        await graph.createRel(edge.fromId, edge.toId, edge.type, edge.properties);
      } catch {
        // target may not exist
      }
    }
  }

  // Index package.json if present
  const packageJsonPath = join(dirname(sourceRoot), 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const pkgInfo: Record<string, unknown> = {};

      if (pkg.name) pkgInfo.name = pkg.name;
      if (pkg.version) pkgInfo.version = pkg.version;
      if (pkg.dependencies) {
        // Extract Vue-related deps
        const deps = pkg.dependencies as Record<string, string>;
        pkgInfo.vueVersion = deps['vue'] ?? deps['vue-demi'] ?? null;
        pkgInfo.hasPinia = 'pinia' in deps;
        pkgInfo.hasVuex = 'vuex' in deps;
        pkgInfo.hasRouter = 'vue-router' in deps;
        pkgInfo.hasVueDemi = 'vue-demi' in deps;
        pkgInfo.frameworkDeps = Object.entries(deps)
          .filter(([name]) =>
            ['vue', 'vue-demi', 'vuex', 'pinia', 'vue-router', 'vite', 'nuxt', 'quasar', 'vuetify', 'element-plus', 'ant-design-vue', 'naive-ui'].includes(name),
          )
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
      }
      if (pkg.scripts) {
        pkgInfo.hasLint = 'lint' in (pkg.scripts as Record<string, string>);
        pkgInfo.hasTest = 'test' in (pkg.scripts as Record<string, string>);
      }

      await graph.execute(
        `CREATE (pkg:Entity {name: '${escapeStr(pkgInfo.name as string || 'unknown')}', filePath: '${escapeStr(packageJsonPath)}', entityType: 'package', properties: '${escapeStr(JSON.stringify(pkgInfo))}'})`,
      );
    } catch {
      // ignore invalid package.json
    }
  }

  await graph.close();

  return {
    entities,
    relations,
    nodeCount: entities.length,
    edgeCount: relations.length,
  };
}

interface ProcessFileResult {
  entity: EntityInstance;
  apiUsage: { fromFile: string; apiName: string; frameworkName: string }[];
  storeItems: { name: string; filePath: string; type: string; properties: Record<string, unknown> }[];
}

async function processFile(
  filePath: string,
  entityType: string,
  config: ResolvedConfig,
  frameworkAPIMap: Map<string, string>,
): Promise<ProcessFileResult | null> {
  const source = readFileSync(filePath, 'utf-8');
  const props: Record<string, unknown> = {};
  const apiUsage: { fromFile: string; apiName: string; frameworkName: string }[] = [];
  const storeItems: { name: string; filePath: string; type: string; properties: Record<string, unknown> }[] = [];

  // Parse source code for AST analysis
  let astRoot: SyntaxNode;
  let sfc: ReturnType<typeof parseSFC> | null = null;

  if (filePath.endsWith('.vue')) {
    sfc = parseSFC(source, filePath);
    props.isVue = true;
    props.usesScriptSetup = sfc.usesScriptSetup;

    if (sfc.mainScript) {
      const scriptContent = extractScriptContent(sfc.mainScript);
      const tree = parseSource(scriptContent);
      astRoot = tree.rootNode;

      props.apiMode = detectApiMode(astRoot);

      extractComponentName(astRoot, props);

      // Detect store usage patterns
      const storeCalls = collect(
        astRoot,
        (n) =>
          n.type === 'call_expression' &&
          (n.childForFieldName('function')?.text?.startsWith('use') ?? false),
      );
      if (storeCalls.length > 0) {
        props.usesStore = true;
        props.storeCalls = storeCalls.map(
          (n) => n.childForFieldName('function')?.text ?? '',
        );
      }

      const mapCalls = collect(
        astRoot,
        (n) =>
          n.type === 'call_expression' &&
          [
            'mapState',
            'mapActions',
            'mapGetters',
            'mapMutations',
          ].includes(n.childForFieldName('function')?.text ?? ''),
      );
      if (mapCalls.length > 0) {
        props.usesMapHelpers = true;
        props.mapHelperCalls = mapCalls.map((n) => ({
          helper: n.childForFieldName('function')?.text ?? '',
          args: n.childForFieldName('arguments')?.text ?? '',
        }));
      }

      // Detect composable usage (useXxx functions from composables)
      detectComposableUsage(astRoot, props);

      // Apply entity markers from config
      applyEntityMarkers(props, sfc, entityType, config);
    } else {
      astRoot = parseSource(source).rootNode;
    }
  } else {
    astRoot = parseSource(source).rootNode;
  }

  // Extract imports
  const imports = extractImports(astRoot);
  if (imports.length > 0) {
    props._imports = imports;
  }

  // Framework API usage detection
  if (config.framework_apis?.length && frameworkAPIMap.size > 0) {
    const importsFromFramework = imports.filter((imp) => {
      for (const fw of config.framework_apis!) {
        if (fw.sources.includes(imp.source)) return true;
      }
      return false;
    });

    if (importsFromFramework.length > 0) {
      // Get all imported names from framework sources
      const importedFrameworkNames = new Set<string>();
      for (const imp of importsFromFramework) {
        for (const name of imp.imports) {
          importedFrameworkNames.add(name);
        }
      }

      // Also detect calls to framework APIs (even without explicit named import,
      // e.g., Vue 3 auto-imported functions)
      const callNodes = collect(astRoot, isCallExpression);
      for (const node of callNodes) {
        const funcName = node.childForFieldName('function')?.text ?? '';
        if (frameworkAPIMap.has(funcName)) {
          apiUsage.push({
            fromFile: filePath,
            apiName: funcName,
            frameworkName: frameworkAPIMap.get(funcName)!,
          });
        }
      }

      // Detect compiler macros in SFC script setup
      if (config.framework_apis) {
        for (const fw of config.framework_apis) {
          if (fw.compiler_macros) {
            for (const macro of fw.compiler_macros) {
              const macroNodes = collect(
                astRoot,
                (n) => n.type === 'call_expression' && n.childForFieldName('function')?.text === macro,
              );
              for (const _ of macroNodes) {
                apiUsage.push({
                  fromFile: filePath,
                  apiName: macro,
                  frameworkName: fw.name,
                });
              }
            }
          }
        }
      }

      // Store framework API info in properties
      props.frameworkApiImports = Array.from(importedFrameworkNames);
    }
  }

  // Store internal structure extraction
  if (entityType === 'store') {
    const storeInternals = extractStoreInternals(astRoot);
    props.hasState = storeInternals.state.length > 0;
    props.hasGetters = storeInternals.getters.length > 0;
    props.hasActions = storeInternals.actions.length > 0;
    props.hasMutations = storeInternals.mutations.length > 0;
    props.stateKeys = storeInternals.state;
    props.getterNames = storeInternals.getters;
    props.actionNames = storeInternals.actions;
    props.mutationNames = storeInternals.mutations;

    // Create StoreItem nodes
    for (const stateName of storeInternals.state) {
      storeItems.push({
        name: stateName,
        filePath: `${filePath}#state:${stateName}`,
        type: 'state',
        properties: { kind: 'state', storePath: filePath },
      });
    }
    for (const getterName of storeInternals.getters) {
      storeItems.push({
        name: getterName,
        filePath: `${filePath}#getter:${getterName}`,
        type: 'getter',
        properties: { kind: 'getter', storePath: filePath },
      });
    }
    for (const actionName of storeInternals.mutations) {
      storeItems.push({
        name: actionName,
        filePath: `${filePath}#mutation:${actionName}`,
        type: 'mutation',
        properties: { kind: 'mutation', storePath: filePath },
      });
    }
    for (const actionName of storeInternals.actions) {
      storeItems.push({
        name: actionName,
        filePath: `${filePath}#action:${actionName}`,
        type: 'action',
        properties: { kind: 'action', storePath: filePath },
      });
    }

    // Auto-detect store variants
    const defineStoreCalls = collect(
      astRoot,
      (n) =>
        n.type === 'call_expression' &&
        n.childForFieldName('function')?.text === 'defineStore',
    );
    if (defineStoreCalls.length > 0) {
      props.variant = 'pinia';
    }

    const vuexStores = collect(
      astRoot,
      (n) =>
        n.type === 'new_expression' &&
        n.text.includes('Store'),
    );
    if (vuexStores.length > 0) {
      props.variant = 'vuex';
    }
  }

  // Route file detection
  if (entityType === 'route') {
    const routeDefs = collect(
      astRoot,
      (n) =>
        n.type === 'call_expression' &&
        (n.childForFieldName('function')?.text === 'createRouter' ||
         n.childForFieldName('function')?.text === 'new VueRouter'),
    );
    if (routeDefs.length > 0) {
      props.isRouter = true;
    }

    // Extract route definitions
    const routeEntries = extractRouteEntries(astRoot);
    if (routeEntries.length > 0) {
      props.routes = routeEntries;
    }
  }

  // Extract JSDoc / @-annotations from comments
  const annotations = extractAnnotations(source);
  if (Object.keys(annotations).length > 0) {
    for (const [key, value] of Object.entries(annotations)) {
      props[`@${key}`] = value;
    }
  }

  return {
    entity: {
      type: entityType,
      id: filePath,
      filePath,
      properties: props,
    },
    apiUsage,
    storeItems,
  };
}

// ===== Entity Marker Application =====

function applyEntityMarkers(
  props: Record<string, unknown>,
  sfc: ReturnType<typeof parseSFC> | null,
  entityType: string,
  config: ResolvedConfig,
): void {
  const entityDef = config.all_entities[entityType];
  if (!entityDef?.markers) return;

  const markers = entityDef.markers;
  for (const marker of markers) {
    if (marker.uses_options_api !== undefined && sfc) {
      props.usesOptionsAPI = marker.uses_options_api;
      // Check if this is a pure options API component
      const isOptions = detectApiMode(
        parseSource(
          sfc.mainScript ? extractScriptContent(sfc.mainScript) : '',
        ).rootNode,
      ) === 'options';
      if (marker.uses_options_api && isOptions) {
        props.markedAsOptionsAPI = true;
      }
    }

    if (marker.naming_pattern) {
      const name = (props.name as string) ?? '';
      const pattern = marker.naming_pattern;
      // Convert naming_pattern glob to regex
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      props.matchesNamingPattern = regex.test(name);
    }
  }
}

// ===== Composable Detection =====

function detectComposableUsage(
  root: SyntaxNode,
  props: Record<string, unknown>,
): void {
  const useCalls = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      /^use[A-Z]/.test(n.childForFieldName('function')?.text ?? ''),
  );

  if (useCalls.length > 0) {
    props.usesComposables = true;
    props.composableCalls = useCalls.map(
      (n) => n.childForFieldName('function')?.text ?? '',
    );
  }
}

// ===== Store Internal Structure Extraction =====

interface StoreInternals {
  state: string[];
  getters: string[];
  mutations: string[];
  actions: string[];
}

function extractStoreInternals(root: SyntaxNode): StoreInternals {
  const result: StoreInternals = { state: [], getters: [], mutations: [], actions: [] };

  // Detect defineStore calls and extract options
  const defineStoreCalls = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      n.childForFieldName('function')?.text === 'defineStore',
  );

  for (const callNode of defineStoreCalls) {
    const args = callNode.childForFieldName('arguments');
    if (!args) continue;

    // defineStore('name', { state: ..., getters: ..., actions: ... }) — Options API store
    // defineStore('name', () => { ... return { ... } }) — Setup store
    for (const child of args.namedChildren) {
      if (child.type === 'object') {
        extractObjectKeys(child, result);
      } else if (child.type === 'arrow_function' || child.type === 'function') {
        // Setup store: look for return statement with object
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

  // For Vuex stores: look for { state: {...}, mutations: {...}, ... }
  if (result.state.length === 0 && result.getters.length === 0) {
    const objects = collect(root, (n) => n.type === 'object');
    for (const obj of objects) {
      extractObjectKeys(obj, result);
    }
  }

  // Deduplicate
  result.state = [...new Set(result.state)];
  result.getters = [...new Set(result.getters)];
  result.mutations = [...new Set(result.mutations)];
  result.actions = [...new Set(result.actions)];

  return result;
}

function extractSetupStoreReturn(
  objNode: SyntaxNode,
  result: StoreInternals,
  bodyNode: SyntaxNode,
): void {
  for (const child of objNode.namedChildren) {
    if (child.type === 'pair' || child.type === 'shorthand_property_identifier') {
      const key = child.type === 'pair'
        ? child.childForFieldName('key')?.text
        : child.text;
      const value = child.type === 'pair' ? child.childForFieldName('value') : null;
      if (!key) continue;

      // For setup stores, we need to trace the definition back to determine the type
      // Look for the variable declaration that defines this key
      const isRef = isSetupStoreRef(key, bodyNode);
      const isComputed = isSetupStoreComputed(key, bodyNode);
      const isFunction = isSetupStoreFunction(key, bodyNode);

      if (isRef) result.state.push(key);
      else if (isComputed) result.getters.push(key);
      else if (isFunction) result.actions.push(key);
      // Fallback: check if the value in the return object looks like a ref/computed/function
      else if (value) {
        const valText = value.text;
        if (valText.startsWith('ref(') || valText.startsWith('reactive(')) result.state.push(key);
        else if (valText.startsWith('computed(')) result.getters.push(key);
        else if (isIdentifier(value)) result.actions.push(key);
      }
    }
  }
}

function isIdentifier(node: import('web-tree-sitter').SyntaxNode): boolean {
  return node.type === 'identifier' || node.type === 'call_expression' || node.type === 'arrow_function';
}

function isSetupStoreRef(name: string, bodyNode: import('web-tree-sitter').SyntaxNode): boolean {
  const decls = collect(
    bodyNode,
    (n) =>
      (n.type === 'variable_declarator' || n.type === 'lexical_declaration') &&
      n.text.includes(name) &&
      (n.text.includes('ref(') || n.text.includes('reactive(')),
  );
  return decls.length > 0;
}

function isSetupStoreComputed(name: string, bodyNode: import('web-tree-sitter').SyntaxNode): boolean {
  const decls = collect(
    bodyNode,
    (n) =>
      (n.type === 'variable_declarator' || n.type === 'lexical_declaration') &&
      n.text.includes(name) &&
      n.text.includes('computed('),
  );
  return decls.length > 0;
}

function isSetupStoreFunction(name: string, bodyNode: import('web-tree-sitter').SyntaxNode): boolean {
  const funcs = collect(
    bodyNode,
    (n) =>
      n.type === 'function_declaration' && n.childForFieldName('name')?.text === name,
  );
  return funcs.length > 0;
}

function extractObjectKeys(
  objNode: SyntaxNode,
  result: StoreInternals,
): void {
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
      if (key) {
        keys.push(key.replace(/^['"]|['"]$/g, ''));
      }
    }
    // Also handle method definitions
    if (child.type === 'method_definition' || child.type === 'public_field_definition') {
      const name = child.childForFieldName('name')?.text;
      if (name) keys.push(name);
    }
  }
  return keys;
}

// ===== Route Entry Extraction =====

interface RouteEntry {
  path?: string;
  name?: string;
  component?: string;
}

function extractRouteEntries(root: SyntaxNode): RouteEntry[] {
  const routes: RouteEntry[] = [];
  // Look for array expressions that contain route objects
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

// ===== Annotation Extraction =====

function extractAnnotations(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Match JSDoc-style @tag: value or @tag value
  const annotationRegex = /(?:@)(\w+(?:-\w+)*)\s*:?\s*(\S[^\n]*?(?=\s*@|\s*\*\/|\s*\n\s*\*\/|\n\s*$|$))/gm;
  let match;
  while ((match = annotationRegex.exec(source)) !== null) {
    const tag = match[1];
    const value = match[2].trim();
    if (!result[tag]) {
      result[tag] = value;
    }
  }
  return result;
}

// ===== Existing helpers (kept with improvements) =====

function detectApiMode(root: SyntaxNode): string {
  const compositionAPIs = [
    'ref', 'computed', 'watch', 'onMounted', 'reactive',
  ];
  const hasSetup = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      compositionAPIs.includes(
        n.childForFieldName('function')?.text ?? '',
      ),
  );

  const hasOptionsAPI = collect(
    root,
    (n) =>
      n.type === 'export_statement' && n.text.includes('default'),
  );

  if (hasSetup.length > 0 && hasOptionsAPI.length > 0) return 'mixed';
  if (hasSetup.length > 0) return 'composition';
  if (hasOptionsAPI.length > 0) return 'options';
  return 'unknown';
}

function extractComponentName(
  root: SyntaxNode,
  props: Record<string, unknown>,
): void {
  const exportNodes = collect(
    root,
    (n) =>
      n.type === 'export_statement' && n.text.includes('default'),
  );

  for (const node of exportNodes) {
    for (const child of node.namedChildren) {
      if (child.type === 'object' || child.type === 'object_literal') {
        for (const pair of child.namedChildren) {
          if (pair.type === 'pair') {
            const key = pair.childForFieldName('key');
            const value = pair.childForFieldName('value');
            if (key?.text === 'name' && value?.type === 'string') {
              props.name = value.text.replace(/^['"]|['"]$/g, '');
            }
          }
        }
      }
      // Handle defineComponent({ name: '...', ... })
      if (child.type === 'call_expression') {
        const func = child.childForFieldName('function');
        if (func?.text === 'defineComponent') {
          const args = child.childForFieldName('arguments');
          if (args) {
            for (const arg of args.namedChildren) {
              if (arg.type === 'object') {
                for (const pair of arg.namedChildren) {
                  if (pair.type === 'pair') {
                    const key = pair.childForFieldName('key');
                    const value = pair.childForFieldName('value');
                    if (key?.text === 'name' && value?.type === 'string') {
                      props.name = value.text.replace(/^['"]|['"]$/g, '');
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

interface ImportInfo {
  source: string;
  imports: string[];
  isDefault: boolean;
}

function extractImports(root: SyntaxNode): ImportInfo[] {
  const importNodes = collect(root, isImportStatement);
  const results: ImportInfo[] = [];

  for (const node of importNodes) {
    let source = '';
    const names: string[] = [];

    for (const child of node.namedChildren) {
      if (child.type === 'string') {
        source = child.text.replace(/^['"]|['"]$/g, '');
      } else if (child.type === 'import_specifier') {
        for (const spec of child.namedChildren) {
          if (spec.type === 'identifier') names.push(spec.text);
        }
      } else if (child.type === 'import_clause') {
        for (const sub of child.descendantsOfType('identifier')) {
          names.push(sub.text);
        }
      } else if (child.type === 'identifier') {
        names.push(child.text);
      }
    }

    results.push({
      source,
      imports: names,
      isDefault: node.text.includes('import ') && !node.text.includes('{'),
    });
  }

  return results;
}

async function buildImportEdges(
  entities: EntityInstance[],
  sourceRoot: string,
): Promise<RelationInstance[]> {
  const relations: RelationInstance[] = [];
  const entityFiles = new Set(entities.map((e) => e.filePath));

  for (const entity of entities) {
    const imports = entity.properties._imports as ImportInfo[] | undefined;
    if (!imports) continue;

    for (const imp of imports) {
      const resolved = resolveImportPath(
        entity.filePath,
        imp.source,
        sourceRoot,
      );
      if (resolved && entityFiles.has(resolved)) {
        relations.push({
          type: 'imports',
          fromId: entity.filePath,
          toId: resolved,
          properties: { importedNames: imp.imports },
        });
      }
    }
  }

  return relations;
}

function resolveImportPath(
  fromFile: string,
  importSource: string,
  sourceRoot: string,
): string | null {
  // Normalize paths to forward slashes for cross-platform consistency
  const toForwardSlash = (p: string) => p.replace(/\\/g, '/');

  // Relative imports: ./foo, ../bar
  if (importSource.startsWith('.')) {
    const dir = dirname(fromFile);
    const basePath = resolve(dir, importSource);
    for (const ext of [
      '', '.vue', '.ts', '.js', '.jsx', '.tsx', '/index.ts', '/index.js', '/index.vue',
    ]) {
      const tryPath = basePath + ext;
      if (existsSync(tryPath)) return toForwardSlash(tryPath);
    }
    return null;
  }

  // @/ alias → source root
  if (importSource.startsWith('@/')) {
    const relative = importSource.slice(2);
    const basePath = resolve(sourceRoot, relative);
    for (const ext of [
      '', '.vue', '.ts', '.js', '.jsx', '.tsx', '/index.ts', '/index.js', '/index.vue',
    ]) {
      const tryPath = basePath + ext;
      if (existsSync(tryPath)) return toForwardSlash(tryPath);
    }
    return null;
  }

  // ~/ alias → project root (parent of source root)
  if (importSource.startsWith('~/')) {
    const projectRoot = dirname(sourceRoot);
    const relative = importSource.slice(2);
    const basePath = resolve(projectRoot, relative);
    for (const ext of [
      '', '.vue', '.ts', '.js', '.jsx', '.tsx', '/index.ts', '/index.js', '/index.vue',
    ]) {
      const tryPath = basePath + ext;
      if (existsSync(tryPath)) return toForwardSlash(tryPath);
    }
    return null;
  }

  // Try tsconfig.json path aliases
  const aliases = readTsconfigAliases(sourceRoot);
  for (const [alias, paths] of Object.entries(aliases)) {
    if (importSource.startsWith(alias)) {
      const relative = importSource.slice(alias.length);
      for (const base of paths) {
        const basePath = resolve(sourceRoot, base.replace(/\*$/, ''), relative);
        for (const ext of [
          '', '.vue', '.ts', '.js', '.jsx', '.tsx', '/index.ts', '/index.js', '/index.vue',
        ]) {
          const tryPath = basePath + ext;
          if (existsSync(tryPath)) return toForwardSlash(tryPath);
        }
      }
    }
  }

  return null;
}

function readTsconfigAliases(sourceRoot: string): Record<string, string[]> {
  const tsconfigPath = join(dirname(sourceRoot), 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    // Also try one level up
    const parent = join(dirname(dirname(sourceRoot)), 'tsconfig.json');
    if (!existsSync(parent)) return {};
    return extractTsconfigPaths(readJsonFile(parent));
  }
  return extractTsconfigPaths(readJsonFile(tsconfigPath));
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function extractTsconfigPaths(tsconfig: Record<string, unknown> | null): Record<string, string[]> {
  if (!tsconfig) return {};
  const compilerOptions = tsconfig.compilerOptions as Record<string, unknown> | undefined;
  if (!compilerOptions?.paths) return {};
  const paths = compilerOptions.paths as Record<string, string[]>;
  const result: Record<string, string[]> = {};
  for (const [alias, targets] of Object.entries(paths)) {
    // Convert tsconfig path: "@/*" → "@/"
    const simple = alias.replace(/\/\*$/, '/');
    result[simple] = targets.map(t => t.replace(/\/\*$/, '/'));
  }
  return result;
}

async function buildRelationshipEdges(
  relType: string,
  relDef: import('../types/config.js').RelationshipDefinition,
  entities: EntityInstance[],
  _config: ResolvedConfig,
): Promise<RelationInstance[]> {
  const relations: RelationInstance[] = [];
  const fromEntities = entities.filter((e) => e.type === relDef.from);
  const toEntities = entities.filter((e) => e.type === relDef.to);


  if (relType === 'route_to_component') {
    }
  if (fromEntities.length === 0 || toEntities.length === 0) return [];

  const detectors = relDef.detect_by ?? [];
  if (detectors.length === 0 && relDef.detector) {
    detectors.push({ type: relDef.detector });
  }

  for (const fromEntity of fromEntities) {
    const source = readFileSync(fromEntity.filePath, 'utf-8');
    const sfc = fromEntity.filePath.endsWith('.vue')
      ? parseSFC(source, fromEntity.filePath)
      : null;

    for (const detectCfg of detectors) {
      const detector = getDetector(detectCfg.type);
      if (!detector) continue;

      let astRoot: SyntaxNode;
      if (sfc?.mainScript) {
        const code = extractScriptContent(sfc.mainScript);
        astRoot = parseSource(code).rootNode;
      } else {
        astRoot = parseSource(source).rootNode;
      }

      const ctx: DetectorContext = {
        source,
        root: astRoot,
        templateContent: sfc?.blocks.find((b) => b.type === 'template')
          ?.content,
        scriptContent: sfc?.mainScript?.content,
      };

      const matches = detector.detect(ctx, {
        pattern: detectCfg.pattern,
      });
      if (relType === 'matches_route') {
            }
    
      for (const match of matches) {
        for (const toEntity of toEntities) {
          if (matchMatchesEntity(match, toEntity, detectCfg.type)) {
                      relations.push({
              type: relType,
              fromId: fromEntity.filePath,
              toId: toEntity.filePath,
              properties: match,
            });
          }
        }
      }
    }
  }

  return relations;
}

function matchMatchesEntity(
  match: Record<string, unknown>,
  entity: EntityInstance,
  detectorType: string,
): boolean {
  const entityName = (entity.properties.name as string) ?? '';
  const entityPath = entity.filePath;

  if (detectorType === 'call_expression') {
    const callee = String(match.callee ?? '');
    const cleanEntityName = entityName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
    const cleanCallee = callee.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
    // Exact name match: useUserStore ↔ user
    if (cleanCallee.includes(cleanEntityName) && cleanEntityName.length > 1) {
      return true;
    }
    // Reverse: entityName contains callee
    if (cleanEntityName.includes(cleanCallee) && cleanCallee.length > 1) {
      return true;
    }
    // UseXxxStore → extract xxx, match against basename
    const calleeCore = callee.replace(/^use/, '').replace(/Store$/i, '').toLowerCase();
    if (calleeCore.length > 2) {
      const basename = entityPath.split(sep).pop()?.replace(/\.[^.]+$/, '').toLowerCase() ?? '';
      if (basename.includes(calleeCore) || calleeCore.includes(basename)) {
        return true;
      }
    }
    // Vuex mapState/mapMutations: extract module name from args
    // e.g. mapState('cart', [...]) → module = 'cart'
    // e.g. mapMutations({ del: 'cart/DEL' }) → module = 'cart'
    if (['mapState', 'mapGetters', 'mapMutations', 'mapActions'].includes(callee)) {
      const args = match.arguments as string[] | undefined;
      if (args && args.length > 0) {
        const vuexModules = extractVuexModules(args);
        for (const mod of vuexModules) {
          const basename = entityPath.split(sep).pop()?.replace(/\.[^.]+$/, '').toLowerCase() ?? '';
          if (basename === mod || entityPath.toLowerCase().includes(sep + mod + sep) || entityPath.toLowerCase().endsWith(sep + mod + '.ts') || entityPath.toLowerCase().endsWith(sep + mod + '.js')) {
            return true;
          }
        }
      }
    }
  }

  if (detectorType === 'member_expression') {
    // $store.commit/dispatch: extract module from arguments
    const memberText = String(match.member ?? match.callee ?? '');
    if (memberText.includes('$store') || memberText.includes('store')) {
      const args = match.arguments as string[] | undefined;
      if (args && args.length > 0) {
        for (const arg of args) {
          const mod = arg.replace(/['"]/g, '').split('/')[0].toLowerCase();
          const basename = entityPath.split(sep).pop()?.replace(/\.[^.]+$/, '').toLowerCase() ?? '';
          if (basename === mod || mod.length > 1 && basename.includes(mod)) {
            return true;
          }
        }
      }
    }
    return entity.type.toLowerCase().includes('store');
  }

  if (detectorType === 'import_expression') {
    const rawPath = String(match.importPath ?? match.callee ?? '');
    const importPath = rawPath.replace(/['"]/g, '');
    if (importPath) {
      const normalized = importPath.replace(/\\/g, '/');
      const importName = normalized.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
      const entityName = entityPath.split(sep).pop()?.replace(/\.[^.]+$/, '') ?? '';
          return importName.toLowerCase() === entityName.toLowerCase();
    }
  }

  return false;
}

function extractVuexModules(args: string[]): string[] {
  const modules = new Set<string>();
  for (const arg of args) {
    if (!arg) continue;
    // String literal: 'cart' or 'cart/DEL_COLLECTION'
    const cleaned = arg.replace(/^['"]|['"]$/g, '').trim();
    if (cleaned.includes('/')) {
      modules.add(cleaned.split('/')[0].toLowerCase());
    } else if (!cleaned.startsWith('[') && !cleaned.startsWith('{')) {
      // Plain module name: 'cart'
      modules.add(cleaned.toLowerCase());
    }
    // Object with keys like { delCollection: 'cart/DEL_COLLECTION' }
    if (arg.startsWith('{')) {
      const matches = arg.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g);
      for (const m of matches) {
        const value = m[2];
        if (value.includes('/')) modules.add(value.split('/')[0].toLowerCase());
      }
    }
  }
  return [...modules];
}

function escapeStr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

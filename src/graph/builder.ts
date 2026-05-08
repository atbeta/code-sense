import { readFileSync, existsSync, rmSync } from 'node:fs';
import { basename, extname, resolve, dirname, join } from 'node:path';
import type { SyntaxNode } from 'web-tree-sitter';
import type { ResolvedConfig } from '../types/config.js';
import type { EntityInstance, RelationInstance } from '../types/graph.js';
import { scanFiles } from '../engine/file-scanner.js';
import { parseSFC, extractScriptContent } from '../engine/sfc-parser.js';
import {
  initParser,
  parseSource,
  detectLanguage,
  collect,
  isImportStatement,
  isCallExpression,
} from '../engine/ast-traverser.js';
import { getDetector } from '../engine/detectors/index.js';
import type { DetectorContext } from '../engine/detectors/base.js';
import { LbugGraph } from './lbug.js';
import { createSchema } from './schema.js';
import { getRegistry } from '../plugins/registry.js';

export interface FunctionDef {
  id: string;
  name: string;
  filePath: string;
  entityPath: string;
  kind:
    | 'function'
    | 'method'
    | 'composable_function'
    | 'setup_function'
    | 'store_action'
    | 'store_mutation';
  startLine: number;
  endLine: number;
  content: string;
}

export interface BuildResult {
  entities: EntityInstance[];
  relations: RelationInstance[];
  functions: FunctionDef[];
  nodeCount: number;
  edgeCount: number;
}

export async function buildGraph(
  config: ResolvedConfig,
  sourceRoot: string,
  dbPath: string,
): Promise<BuildResult> {
  await initParser();

  // ── Activate plugins ──
  const registry = getRegistry();
  const projectRoot = process.cwd();
  // Use sourceRoot for plugin detection so plugins can find .vue files etc.
  const pluginContrib = await registry.activate(sourceRoot);

  // Merge plugin contributions into config
  const mergedConfig: ResolvedConfig = {
    ...config,
    all_entities: { ...config.all_entities, ...pluginContrib.entities },
    framework_apis: [...(config.framework_apis ?? []), ...pluginContrib.frameworkAPIs],
    relationships: { ...(config.relationships ?? {}), ...pluginContrib.relationships },
  };

  // Announce activated plugins
  const activated = registry.listActivated();
  if (activated.length > 0) {
    console.log(`[CodeSense] Plugins activated: ${activated.join(', ')}`);
  }

  // Clean existing database for fresh rebuild
  try {
    rmSync(dbPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    rmSync(dbPath + '.wal', { force: true });
  } catch {
    /* ignore */
  }

  const graph = new LbugGraph(dbPath);
  await createSchema(graph, mergedConfig);

  const scanned = await scanFiles(mergedConfig, sourceRoot);

  const entities: EntityInstance[] = [];
  const functions: FunctionDef[] = [];
  const frameworkAPIUsage: { fromFile: string; apiName: string; frameworkName: string }[] = [];

  // Collect all framework API names for detection
  const frameworkAPIMap = new Map<string, string>();
  for (const fw of mergedConfig.framework_apis ?? []) {
    for (const api of fw.api_list) {
      frameworkAPIMap.set(api, fw.name);
    }
  }

  for (const file of scanned) {
    const result = await processFile(file.filePath, file.entityType, mergedConfig, frameworkAPIMap);
    if (result) {
      entities.push(result.entity);
      functions.push(...result.functions);
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
        await graph.execute(
          `MATCH (a:Entity {filePath: '${escapeStr(result.entity.filePath)}'}) MATCH (b:StoreItem {filePath: '${escapeStr(item.filePath)}'}) CREATE (a)-[:has_item]->(b)`,
        );
      }
    }
  }

  // Index framework API nodes
  for (const fw of mergedConfig.framework_apis ?? []) {
    for (const apiName of fw.api_list) {
      try {
        await graph.execute(`CREATE (fw:FrameworkAPI {name: '${escapeStr(apiName)}'})`);
      } catch {
        /* node may already exist */
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
      /* target may not exist */
    }
  }

  const relations: RelationInstance[] = [];

  // Config-defined relationships
  for (const [relType, relDef] of Object.entries(mergedConfig.relationships ?? {})) {
    if (relType === 'imports') continue;
    const relEdges = await buildRelationshipEdges(relType, relDef, entities, mergedConfig);
    for (const edge of relEdges) {
      relations.push(edge);
      try {
        await graph.createRel(edge.fromId, edge.toId, edge.type, edge.properties);
      } catch {
        /* target may not exist */
      }
    }
  }

  // Auto-detected imports
  const importEdges = await buildImportEdges(entities, sourceRoot);
  for (const edge of importEdges) {
    relations.push(edge);
    try {
      await graph.createRel(edge.fromId, edge.toId, edge.type, edge.properties);
    } catch {
      /* target may not exist */
    }
  }

  // Index package.json
  const packageJsonPath = join(dirname(sourceRoot), 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const pkgInfo: Record<string, unknown> = {};
      if (pkg.name) pkgInfo.name = pkg.name;
      if (pkg.version) pkgInfo.version = pkg.version;
      if (pkg.dependencies) {
        const deps = pkg.dependencies as Record<string, string>;
        pkgInfo.vueVersion = deps['vue'] ?? deps['vue-demi'] ?? null;
        pkgInfo.hasPinia = 'pinia' in deps;
        pkgInfo.hasVuex = 'vuex' in deps;
        pkgInfo.hasRouter = 'vue-router' in deps;
        pkgInfo.hasVueDemi = 'vue-demi' in deps;
        pkgInfo.frameworkDeps = Object.entries(deps)
          .filter(([name]) =>
            [
              'vue',
              'vue-demi',
              'vuex',
              'pinia',
              'vue-router',
              'vite',
              'nuxt',
              'quasar',
              'vuetify',
              'element-plus',
              'ant-design-vue',
              'naive-ui',
            ].includes(name),
          )
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
      }
      if (pkg.scripts) {
        pkgInfo.hasLint = 'lint' in (pkg.scripts as Record<string, string>);
        pkgInfo.hasTest = 'test' in (pkg.scripts as Record<string, string>);
      }
      await graph.execute(
        `CREATE (pkg:Entity {name: '${escapeStr((pkgInfo.name as string) || 'unknown')}', filePath: '${escapeStr(packageJsonPath)}', entityType: 'package', properties: '${escapeStr(JSON.stringify(pkgInfo))}'})`,
      );
    } catch {
      /* ignore invalid package.json */
    }
  }

  // Write Function nodes
  for (const fn of functions) {
    try {
      await graph.execute(
        `CREATE (f:Function {id: '${escapeStr(fn.id)}', name: '${escapeStr(fn.name)}', filePath: '${escapeStr(fn.filePath)}', entityPath: '${escapeStr(fn.entityPath)}', kind: '${escapeStr(fn.kind)}', startLine: ${fn.startLine}, endLine: ${fn.endLine}, content: '${escapeStr(fn.content)}'})`,
      );
      await graph.execute(
        `MATCH (e:Entity {filePath: '${escapeStr(fn.entityPath)}'}) MATCH (f:Function {id: '${escapeStr(fn.id)}'}) CREATE (e)-[:defines]->(f)`,
      );
    } catch {
      /* may already exist */
    }
  }

  // Build CALLS edges between functions
  if (functions.length > 0) {
    const functionNames = new Set(functions.map((f) => f.name));
    const funcByName = new Map<string, FunctionDef[]>();
    for (const fn of functions) {
      const list = funcByName.get(fn.name) ?? [];
      list.push(fn);
      funcByName.set(fn.name, list);
    }

    for (const caller of functions) {
      const callPattern = /(?:^|[^\w])([\w$]+)\s*\(/g;
      let match: RegExpExecArray | null;
      const called: Set<string> = new Set();
      while ((match = callPattern.exec(caller.content)) !== null) {
        const calledName = match[1];
        if (
          [
            'if',
            'switch',
            'for',
            'while',
            'return',
            'throw',
            'typeof',
            'instanceof',
            'new',
            'import',
            'export',
            'require',
            'console',
            'JSON',
            'Math',
            'Object',
            'Array',
            'String',
            'Number',
            'Boolean',
            'Promise',
            'Map',
            'Set',
            'Ref',
            'ComputedRef',
            'parseInt',
            'parseFloat',
            'isNaN',
          ].includes(calledName)
        )
          continue;
        if (!functionNames.has(calledName)) continue;
        if (calledName === caller.name) continue;
        called.add(calledName);
      }

      for (const targetName of called) {
        const targets = funcByName.get(targetName);
        if (!targets) continue;
        for (const target of targets) {
          try {
            await graph.execute(
              `MATCH (a:Function {id: '${escapeStr(caller.id)}'}) MATCH (b:Function {id: '${escapeStr(target.id)}'}) CREATE (a)-[:CALLS {confidence: 0.7, callSite: '${escapeStr(caller.name + '→' + target.name)}'}]->(b)`,
            );
          } catch {
            /* edge may already exist */
          }
        }
      }
    }
  }

  // Plugin post-processing hook
  await registry.afterGraphBuilt({ entities, relations, graph, projectRoot, config: mergedConfig });

  await graph.close();

  return {
    entities,
    relations,
    functions,
    nodeCount: entities.length + functions.length,
    edgeCount: relations.length,
  };
}

// ===== Process File =====

interface ProcessFileResult {
  entity: EntityInstance;
  apiUsage: { fromFile: string; apiName: string; frameworkName: string }[];
  storeItems: {
    name: string;
    filePath: string;
    type: string;
    properties: Record<string, unknown>;
  }[];
  functions: FunctionDef[];
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
  const storeItems: {
    name: string;
    filePath: string;
    type: string;
    properties: Record<string, unknown>;
  }[] = [];
  let functions: FunctionDef[];

  const defaultLang = detectLanguage(filePath);
  let astRoot: SyntaxNode;
  let sfc: ReturnType<typeof parseSFC> | null = null;

  // ── Plugin-based entity extraction ──
  const registry = getRegistry();
  const projectRoot = process.cwd();

  const pluginResult = await registry.extractEntity({
    filePath,
    source,
    astRoot: parseSource(source, defaultLang).rootNode, // temporary, may be replaced by plugin
    entityType,
    language: defaultLang,
    config,
    projectRoot,
    sourceRoot: resolve(projectRoot, config.project.source_root),
  });

  Object.assign(props, pluginResult.properties);
  apiUsage.push(...pluginResult.apiUsage);
  storeItems.push(...pluginResult.storeItems);

  // Re-parse with correct language if plugin modified understanding
  if (filePath.endsWith('.vue')) {
    sfc = parseSFC(source, filePath);
    if (sfc.mainScript) {
      const scriptLang =
        sfc.mainScript.attrs.includes('lang="ts"') || sfc.mainScript.attrs.includes("lang='ts'")
          ? ('ts' as const)
          : 'js';
      const scriptContent = extractScriptContent(sfc.mainScript);
      astRoot = parseSource(scriptContent, scriptLang).rootNode;
    } else {
      astRoot = parseSource(source, defaultLang).rootNode;
    }
  } else {
    astRoot = parseSource(source, defaultLang).rootNode;
  }

  // Extract imports
  const imports = extractImports(astRoot);
  if (imports.length > 0) {
    props._imports = imports;
  }

  // Generic framework API usage detection (works without vue plugin too)
  if (config.framework_apis?.length && frameworkAPIMap.size > 0) {
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
    // Compiler macros
    for (const fw of config.framework_apis) {
      if (fw.compiler_macros) {
        for (const macro of fw.compiler_macros) {
          const macroNodes = collect(
            astRoot,
            (n) => n.type === 'call_expression' && n.childForFieldName('function')?.text === macro,
          );
          for (const _ of macroNodes) {
            apiUsage.push({ fromFile: filePath, apiName: macro, frameworkName: fw.name });
          }
        }
      }
    }
  }

  // ── Plugin-based function classification ──
  const classResult = registry.classifyFunctions({
    filePath,
    entityType,
    astRoot,
    sfc: sfc
      ? {
          usesScriptSetup: sfc.usesScriptSetup,
          mainScript: sfc.mainScript ? { attrs: sfc.mainScript.attrs } : undefined,
        }
      : null,
  });
  if (classResult.functions.length > 0) {
    functions = classResult.functions;
  } else {
    // Fallback: generic function extraction
    functions = extractGenericFunctions(astRoot, filePath, entityType);
  }

  // Extract JSDoc annotations
  const annotations = extractAnnotations(source);
  if (Object.keys(annotations).length > 0) {
    for (const [key, value] of Object.entries(annotations)) {
      props[`@${key}`] = value;
    }
  }

  return {
    entity: { type: entityType, id: filePath, filePath, properties: props },
    apiUsage,
    storeItems,
    functions,
  };
}

// ===== Generic Function Extraction (fallback when no plugin provides) =====

function extractGenericFunctions(
  root: SyntaxNode,
  filePath: string,
  _entityType: string,
): FunctionDef[] {
  const result: FunctionDef[] = [];
  const seen = new Set<string>();

  function addFn(
    name: string,
    kind: FunctionDef['kind'],
    startLine: number,
    endLine: number,
    node: SyntaxNode,
  ): void {
    const id = `${filePath}#${name}:${startLine}`;
    if (seen.has(id)) return;
    seen.add(id);
    const content = node.text.length > 300 ? node.text.substring(0, 300) + '...' : node.text;
    result.push({ id, name, filePath, entityPath: filePath, kind, startLine, endLine, content });
  }

  // function_declaration
  for (const node of collect(root, (n) => n.type === 'function_declaration')) {
    const name = node.childForFieldName('name')?.text;
    if (!name || (name.startsWith('_') && name.length > 1)) continue;
    addFn(name, 'function', node.startPosition.row + 1, node.endPosition.row + 1, node);
  }

  // const/let foo = () => { ... } or function() { ... }
  for (const decl of collect(root, (n) => n.type === 'lexical_declaration')) {
    for (const child of decl.namedChildren) {
      if (child.type !== 'variable_declarator') continue;
      const nameNode = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (!nameNode || !valueNode) continue;
      const name = nameNode.text;
      if (name.startsWith('_') && name.length > 1) continue;
      const isArrow = valueNode.type === 'arrow_function';
      const isFuncExpr = valueNode.type === 'function';
      if (!isArrow && !isFuncExpr) continue;
      addFn(name, 'function', child.startPosition.row + 1, child.endPosition.row + 1, child);
    }
  }

  return result;
}

// ===== Annotation Extraction =====

function extractAnnotations(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const annotationRegex =
    /(?:@)(\w+(?:-\w+)*)\s*:?\s*(\S[^\n]*?(?=\s*@|\s*\*\/|\s*\n\s*\*\/|\n\s*$|$))/gm;
  let match;
  while ((match = annotationRegex.exec(source)) !== null) {
    const tag = match[1];
    const value = match[2].trim();
    if (!result[tag]) result[tag] = value;
  }
  return result;
}

// ===== Import Extraction =====

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

// ===== Import Edge Building =====

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
      const resolved = resolveImportPath(entity.filePath, imp.source, sourceRoot);
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
  const toForwardSlash = (p: string) => p.replace(/\\/g, '/');

  if (importSource.startsWith('.')) {
    const dir = dirname(fromFile);
    const basePath = resolve(dir, importSource);
    for (const ext of [
      '',
      '.vue',
      '.ts',
      '.js',
      '.jsx',
      '.tsx',
      '/index.ts',
      '/index.js',
      '/index.vue',
    ]) {
      const tryPath = basePath + ext;
      if (existsSync(tryPath)) return toForwardSlash(tryPath);
    }
    return null;
  }

  if (importSource.startsWith('@/')) {
    const relative = importSource.slice(2);
    const basePath = resolve(sourceRoot, relative);
    for (const ext of [
      '',
      '.vue',
      '.ts',
      '.js',
      '.jsx',
      '.tsx',
      '/index.ts',
      '/index.js',
      '/index.vue',
    ]) {
      const tryPath = basePath + ext;
      if (existsSync(tryPath)) return toForwardSlash(tryPath);
    }
    return null;
  }

  if (importSource.startsWith('~/')) {
    const projectRoot = dirname(sourceRoot);
    const relative = importSource.slice(2);
    const basePath = resolve(projectRoot, relative);
    for (const ext of [
      '',
      '.vue',
      '.ts',
      '.js',
      '.jsx',
      '.tsx',
      '/index.ts',
      '/index.js',
      '/index.vue',
    ]) {
      const tryPath = basePath + ext;
      if (existsSync(tryPath)) return toForwardSlash(tryPath);
    }
    return null;
  }

  const aliases = readTsconfigAliases(sourceRoot);
  for (const [alias, paths] of Object.entries(aliases)) {
    if (importSource.startsWith(alias)) {
      const relative = importSource.slice(alias.length);
      for (const base of paths) {
        const basePath = resolve(sourceRoot, base.replace(/\*$/, ''), relative);
        for (const ext of [
          '',
          '.vue',
          '.ts',
          '.js',
          '.jsx',
          '.tsx',
          '/index.ts',
          '/index.js',
          '/index.vue',
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
    const simple = alias.replace(/\/\*$/, '/');
    result[simple] = targets.map((t) => t.replace(/\/\*$/, '/'));
  }
  return result;
}

// ===== Relationship Edge Building =====

async function buildRelationshipEdges(
  relType: string,
  relDef: import('../types/config.js').RelationshipDefinition,
  entities: EntityInstance[],
  _config: ResolvedConfig,
): Promise<RelationInstance[]> {
  const relations: RelationInstance[] = [];
  const fromEntities = entities.filter((e) => e.type === relDef.from);
  const toEntities = entities.filter((e) => e.type === relDef.to);

  if (fromEntities.length === 0 || toEntities.length === 0) return [];

  const detectors = relDef.detect_by ?? [];
  if (detectors.length === 0 && relDef.detector) {
    detectors.push({ type: relDef.detector });
  }

  for (const fromEntity of fromEntities) {
    const source = readFileSync(fromEntity.filePath, 'utf-8');
    const sfc = fromEntity.filePath.endsWith('.vue') ? parseSFC(source, fromEntity.filePath) : null;

    for (const detectCfg of detectors) {
      const detector = getDetector(detectCfg.type);
      if (!detector) continue;

      let astRoot: SyntaxNode;
      if (sfc?.mainScript) {
        const code = extractScriptContent(sfc.mainScript);
        const scriptLang =
          sfc.mainScript.attrs.includes('lang="ts"') || sfc.mainScript.attrs.includes("lang='ts'")
            ? ('ts' as const)
            : 'js';
        astRoot = parseSource(code, scriptLang).rootNode;
      } else {
        astRoot = parseSource(source).rootNode;
      }

      const ctx: DetectorContext = {
        source,
        root: astRoot,
        templateContent: sfc?.blocks.find((b) => b.type === 'template')?.content,
        scriptContent: sfc?.mainScript?.content,
      };

      const matches = detector.detect(ctx, { pattern: detectCfg.pattern });

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
  const entityPath = entity.filePath.replace(/\\/g, '/');

  if (detectorType === 'call_expression') {
    const callee = String(match.callee ?? '');
    const cleanEntityName = entityName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
    const cleanCallee = callee.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');

    if (cleanCallee.includes(cleanEntityName) && cleanEntityName.length > 1) return true;
    if (cleanEntityName.includes(cleanCallee) && cleanCallee.length > 1) return true;

    const calleeCore = callee
      .replace(/^use/, '')
      .replace(/Store$/i, '')
      .toLowerCase();
    if (calleeCore.length > 2) {
      const basename =
        entityPath
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '')
          .toLowerCase() ?? '';
      if (basename.includes(calleeCore) || calleeCore.includes(basename)) return true;
    }

    if (['mapState', 'mapGetters', 'mapMutations', 'mapActions'].includes(callee)) {
      const args = match.arguments as string[] | undefined;
      if (args && args.length > 0) {
        const vuexModules = extractVuexModules(args);
        for (const mod of vuexModules) {
          const basename =
            entityPath
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '')
              .toLowerCase() ?? '';
          if (
            basename === mod ||
            entityPath.toLowerCase().includes('/' + mod + '/') ||
            entityPath.toLowerCase().endsWith('/' + mod + '.ts') ||
            entityPath.toLowerCase().endsWith('/' + mod + '.js')
          ) {
            return true;
          }
        }
      }
    }
  }

  if (detectorType === 'member_expression') {
    const memberText = String(match.member ?? match.callee ?? '');
    if (memberText.includes('$store') || memberText.includes('store')) {
      const args = match.arguments as string[] | undefined;
      if (args && args.length > 0) {
        for (const arg of args) {
          const mod = arg.replace(/['"]/g, '').split('/')[0].toLowerCase();
          const basename =
            entityPath
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '')
              .toLowerCase() ?? '';
          if (basename === mod || (mod.length > 1 && basename.includes(mod))) return true;
        }
      }
    }
    return entity.type.toLowerCase().includes('store');
  }

  if (detectorType === 'import_expression') {
    const importPath = String(match.importPath ?? match.callee ?? '').replace(/['"]/g, '');
    if (importPath) {
      const normalizedImport = importPath.replace(/\\/g, '/');
      const normalizedEntity = entityPath.replace(/\\/g, '/');
      const importName =
        normalizedImport
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') ?? '';
      const normalized =
        normalizedEntity
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') ?? '';
      return importName.toLowerCase() === normalized.toLowerCase();
    }
  }

  return false;
}

function extractVuexModules(args: string[]): string[] {
  const modules = new Set<string>();
  for (const arg of args) {
    if (!arg) continue;
    const cleaned = arg.replace(/^['"]|['"]$/g, '').trim();
    if (cleaned.includes('/')) {
      modules.add(cleaned.split('/')[0].toLowerCase());
    } else if (!cleaned.startsWith('[') && !cleaned.startsWith('{')) {
      modules.add(cleaned.toLowerCase());
    }
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

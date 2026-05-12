import { createInterface, type Interface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

interface Questioner {
  question(prompt: string): Promise<string>;
  close(): void;
}

interface ProjectProbe {
  cwd: string;
  projectName: string;
  sourceRoot: string;
  extension: 'ts' | 'js';
  deps: Record<string, string>;
  hasComposables: boolean;
  hasElectron: boolean;
  hasLayouts: boolean;
  hasMixins: boolean;
  hasPages: boolean;
  hasPlugins: boolean;
  hasRouter: boolean;
  hasStore: boolean;
  hasStores: boolean;
}

interface InteractiveAnswers {
  projectName: string;
  sourceRoot: string;
  extension: 'ts' | 'js';
  includeComposables: boolean;
  includeElectron: boolean;
  includeLayouts: boolean;
  includeMixins: boolean;
  includePages: boolean;
  includePlugins: boolean;
  router: boolean;
  stores: 'pinia' | 'vuex' | 'both' | 'none';
}

export async function createInitConfig(cwd: string, interactive: boolean): Promise<string> {
  const probe = probeProject(cwd);
  if (!interactive) return createMinimalConfig(probe);

  const answers = await promptInteractiveConfig(probe);
  return createInteractiveConfig(answers);
}

export function probeProject(cwd: string): ProjectProbe {
  const packageJson = readPackageJson(cwd);
  const deps = {
    ...((packageJson.dependencies as Record<string, string> | undefined) ?? {}),
    ...((packageJson.devDependencies as Record<string, string> | undefined) ?? {}),
  };

  const srcDir = resolve(cwd, 'src');
  const hasRootElectron = existsSync(resolve(cwd, 'electron'));
  const sourceRoot = hasRootElectron ? '.' : existsSync(srcDir) ? 'src' : '.';
  const sourceRootPath = resolve(cwd, sourceRoot);
  const srcRootPath = resolve(cwd, 'src');
  const files = existsSync(sourceRootPath) ? scanDir(sourceRootPath, 4) : [];
  const tsCount = files.filter((f) => f.endsWith('.ts') || f.endsWith('.vue')).length;
  const jsCount = files.filter((f) => f.endsWith('.js')).length;

  return {
    cwd,
    projectName: (packageJson.name as string | undefined) ?? cwd.split(sep).pop() ?? 'my-project',
    sourceRoot,
    extension: jsCount > tsCount ? 'js' : 'ts',
    deps,
    hasComposables:
      existsSync(resolve(sourceRootPath, 'composables')) ||
      existsSync(resolve(srcRootPath, 'composables')),
    hasElectron:
      Boolean(deps.electron || deps['electron-builder'] || deps['electron-vite']) ||
      existsSync(resolve(sourceRootPath, 'electron')) ||
      existsSync(resolve(cwd, 'electron')),
    hasLayouts:
      existsSync(resolve(sourceRootPath, 'layouts')) || existsSync(resolve(srcRootPath, 'layouts')),
    hasMixins:
      existsSync(resolve(sourceRootPath, 'mixins')) || existsSync(resolve(srcRootPath, 'mixins')),
    hasPages:
      existsSync(resolve(sourceRootPath, 'pages')) ||
      existsSync(resolve(sourceRootPath, 'views')) ||
      existsSync(resolve(srcRootPath, 'pages')) ||
      existsSync(resolve(srcRootPath, 'views')),
    hasPlugins:
      existsSync(resolve(sourceRootPath, 'plugins')) || existsSync(resolve(srcRootPath, 'plugins')),
    hasRouter:
      Boolean(deps['vue-router']) ||
      existsSync(resolve(sourceRootPath, 'router')) ||
      existsSync(resolve(srcRootPath, 'router')),
    hasStore:
      Boolean(deps.pinia || deps.vuex) ||
      existsSync(resolve(sourceRootPath, 'store')) ||
      existsSync(resolve(sourceRootPath, 'stores')) ||
      existsSync(resolve(srcRootPath, 'store')) ||
      existsSync(resolve(srcRootPath, 'stores')),
    hasStores:
      existsSync(resolve(sourceRootPath, 'stores')) || existsSync(resolve(srcRootPath, 'stores')),
  };
}

function createMinimalConfig(probe: ProjectProbe): string {
  const storeDir = probe.hasStores ? 'stores' : 'store';
  const srcPrefix = probe.sourceRoot === '.' && existsSync(resolve(probe.cwd, 'src')) ? 'src/' : '';

  return `# CodeSense configuration - minimal starter
# Only project.name + entities are required. Everything else is optional.

project:
  name: "${escapeYamlString(probe.projectName)}"
  source_root: "${escapeYamlString(probe.sourceRoot)}"

entities:
  component:
    patterns:
      - "**/*.vue"
  store:
    patterns:
      - "${srcPrefix}${storeDir}/**/*.{js,ts}"
  route:
    patterns:
      - "${srcPrefix}router/**/*.{js,ts}"
`;
}

async function promptInteractiveConfig(probe: ProjectProbe): Promise<InteractiveAnswers> {
  const questions = createQuestioner();
  try {
    console.log('CodeSense interactive init');
    console.log('Press Enter to accept the suggested value.\n');

    const projectName = await askText(questions, 'Project name', probe.projectName);
    const sourceRoot = await askText(questions, 'Source root', probe.sourceRoot);
    const extension = await askChoice(
      questions,
      'Primary script language',
      ['ts', 'js'],
      probe.extension,
    );
    const router = await askYes(
      questions,
      'Track Vue Router routes and route-to-component links',
      probe.hasRouter,
    );
    const stores = await askChoice(
      questions,
      'Track stores',
      ['pinia', 'vuex', 'both', 'none'],
      detectStoreChoice(probe),
    );
    const includeComposables = await askYes(
      questions,
      'Track composables and component-to-composable usage',
      probe.hasComposables,
    );
    const includePages = await askYes(
      questions,
      'Track pages/views as route entry components',
      probe.hasPages,
    );
    const includeLayouts = await askYes(questions, 'Track layouts', probe.hasLayouts);
    const includePlugins = await askYes(questions, 'Track app plugins', probe.hasPlugins);
    const includeMixins = await askYes(questions, 'Track Options API mixins', probe.hasMixins);
    const includeElectron = await askYes(
      questions,
      'Track Electron main/preload/renderer IPC',
      probe.hasElectron,
    );

    return {
      projectName,
      sourceRoot,
      extension,
      includeComposables,
      includeElectron,
      includeLayouts,
      includeMixins,
      includePages,
      includePlugins,
      router,
      stores,
    };
  } finally {
    questions.close();
  }
}

function createInteractiveConfig(answers: InteractiveAnswers): string {
  const ext = answers.extension;
  const srcPrefix = answers.sourceRoot === '.' ? 'src/' : '';
  const linesForPatterns = (patterns: string[]) => {
    const expanded = srcPrefix
      ? [...patterns, ...patterns.map((pattern) => srcPrefix + pattern)]
      : patterns;
    return expanded.map((pattern) => `      - "${pattern}"`).join('\n');
  };
  const entities: string[] = [
    `  component:
    patterns:
      - "**/*.vue"`,
  ];

  if (answers.includeComposables) {
    entities.push(`  composable:
    description: "Vue composable modules"
    patterns:
${linesForPatterns([`composables/**/*.${ext}`, 'composables/**/*.js'])}
    markers:
      - naming_pattern: "use[A-Z]*"`);
  }

  if (answers.stores !== 'none') {
    entities.push(`  store:
    description: "Pinia or Vuex store modules"
    patterns:
${linesForPatterns([
  `stores/**/*.${ext}`,
  'stores/**/*.js',
  `store/**/*.${ext}`,
  'store/**/*.js',
  `vuex/**/*.${ext}`,
  'vuex/**/*.js',
])}`);
  }

  if (answers.router) {
    entities.push(`  route:
    description: "Vue Router route definition files"
    patterns:
${linesForPatterns([`router/**/*.${ext}`, 'router/**/*.js', `routes/**/*.${ext}`, 'routes/**/*.js'])}`);
  }

  if (answers.includePages) {
    entities.push(`  page:
    description: "Vue pages or route views"
    patterns:
${linesForPatterns(['pages/**/*.vue', 'views/**/*.vue'])}`);
  }

  if (answers.includeLayouts) {
    entities.push(`  layout:
    description: "Vue layout components"
    patterns:
${linesForPatterns(['layouts/**/*.vue'])}`);
  }

  if (answers.includePlugins) {
    entities.push(`  plugin:
    description: "Vue app plugins"
    patterns:
${linesForPatterns([`plugins/**/*.${ext}`, 'plugins/**/*.js'])}`);
  }

  if (answers.includeMixins) {
    entities.push(`  mixin:
    description: "Options API mixins"
    patterns:
${linesForPatterns([`mixins/**/*.${ext}`, 'mixins/**/*.js', 'mixins/**/*.vue'])}`);
  }

  if (answers.includeElectron) {
    entities.push(`  electron-main:
    description: "Electron main process entry points"
    patterns:
${linesForPatterns([
  `electron/main.${ext}`,
  'electron/main.js',
  `electron/index.${ext}`,
  'electron/index.js',
  `main/**/*.${ext}`,
  'main/**/*.js',
])}
  preload:
    description: "Electron preload scripts"
    patterns:
${linesForPatterns([
  `electron/preload/**/*.${ext}`,
  'electron/preload/**/*.js',
  `electron/preload.${ext}`,
  'electron/preload.js',
  `preload/**/*.${ext}`,
  'preload/**/*.js',
])}`);
  }

  const frameworkApis = createFrameworkApis(answers);
  const relationships = createRelationships(answers);

  return `# CodeSense configuration - interactive Vue/Electron setup
# Generated by \`code-sense init --interactive\`.

project:
  name: "${escapeYamlString(answers.projectName)}"
  source_root: "${escapeYamlString(answers.sourceRoot)}"

entities:
${entities.join('\n\n')}

framework_apis:
${frameworkApis.join('\n')}

relationships:
${relationships.join('\n\n')}

custom_entities: {}
`;
}

function createFrameworkApis(answers: InteractiveAnswers): string[] {
  const apis = [
    `  - name: "vue"
    sources:
      - "vue"
      - "vue-demi"
    api_list:
      - "ref"
      - "reactive"
      - "computed"
      - "watch"
      - "watchEffect"
      - "onMounted"
      - "onUnmounted"
      - "onBeforeMount"
      - "onBeforeUnmount"
      - "onUpdated"
      - "onBeforeUpdate"
      - "provide"
      - "inject"
      - "defineComponent"
      - "defineAsyncComponent"
      - "nextTick"
      - "toRef"
      - "toRefs"
      - "storeToRefs"
    compiler_macros:
      - "defineProps"
      - "defineEmits"
      - "defineExpose"
      - "defineOptions"
      - "defineSlots"
      - "defineModel"
      - "withDefaults"`,
  ];

  if (answers.router) {
    apis.push(`  - name: "vue-router"
    sources:
      - "vue-router"
    api_list:
      - "createRouter"
      - "createWebHistory"
      - "createWebHashHistory"
      - "createMemoryHistory"
      - "useRouter"
      - "useRoute"
      - "onBeforeRouteUpdate"
      - "onBeforeRouteLeave"`);
  }

  if (answers.stores === 'pinia' || answers.stores === 'both') {
    apis.push(`  - name: "pinia"
    sources:
      - "pinia"
    api_list:
      - "defineStore"
      - "createPinia"
      - "useStore"
      - "storeToRefs"
      - "setActivePinia"
      - "getActivePinia"`);
  }

  if (answers.stores === 'vuex' || answers.stores === 'both') {
    apis.push(`  - name: "vuex"
    sources:
      - "vuex"
    api_list:
      - "mapState"
      - "mapGetters"
      - "mapActions"
      - "mapMutations"
      - "createStore"
      - "useStore"`);
  }

  return apis;
}

function createRelationships(answers: InteractiveAnswers): string[] {
  const relationships = [
    `  imports:
    description: "File-level import dependency"
    from: "component"
    to: "component"`,
    `  uses_component:
    description: "Vue template renders another Vue component"
    from: "component"
    to: "component"
    detect_by: []`,
  ];

  if (answers.stores !== 'none') {
    relationships.push(`  uses_store:
    description: "Component uses a Pinia or Vuex store"
    from: "component"
    to: "store"
    detect_by:
      - type: "call_expression"
        pattern: "use*Store"
      - type: "call_expression"
        pattern: "mapState"
      - type: "call_expression"
        pattern: "mapActions"
      - type: "call_expression"
        pattern: "mapGetters"
      - type: "call_expression"
        pattern: "mapMutations"
      - type: "member_expression"
        pattern: "$store.*"`);
  }

  if (answers.includeComposables) {
    relationships.push(`  uses_composable:
    description: "Component calls a Vue composable"
    from: "component"
    to: "composable"
    detect_by:
      - type: "call_expression"
        pattern: "use*"`);
  }

  if (answers.router) {
    relationships.push(`  route_to_component:
    description: "Route definition references a component"
    from: "route"
    to: "component"
    detect_by:
      - type: "import_statement"
        pattern: ".vue$"
      - type: "import_expression"
        pattern: "*"`);
  }

  if (answers.includeMixins) {
    relationships.push(`  uses_mixin:
    description: "Component uses an Options API mixin"
    from: "component"
    to: "mixin"
    detect_by: []`);
  }

  if (answers.includeElectron) {
    relationships.push(`  ipc_channel:
    description: "Main process handles an IPC channel"
    from: "electron-main"
    to: "electron-main"
    detect_by:
      - type: "call_expression"
        pattern: "ipcMain.handle"
      - type: "call_expression"
        pattern: "ipcMain.on"`);
    relationships.push(`  exposes_ipc:
    description: "Preload script exposes IPC methods to renderer"
    from: "preload"
    to: "electron-main"
    detect_by:
      - type: "call_expression"
        pattern: "contextBridge.exposeInMainWorld"`);
    relationships.push(`  calls_ipc:
    description: "Renderer calls IPC through preload bridge or ipcRenderer"
    from: "component"
    to: "electron-main"
    detect_by:
      - type: "call_expression"
        pattern: "ipcRenderer.invoke"
      - type: "call_expression"
        pattern: "ipcRenderer.send"
      - type: "member_expression"
        pattern: "window.*"`);
  }

  return relationships;
}

async function askText(
  questions: Questioner,
  question: string,
  defaultValue: string,
): Promise<string> {
  const answer = (await questions.question(`${question} [${defaultValue}]: `)).trim();
  return answer || defaultValue;
}

async function askYes(
  questions: Questioner,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await questions.question(`${question} [${suffix}]: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ['y', 'yes'].includes(answer);
}

async function askChoice<T extends string>(
  questions: Questioner,
  question: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  const answer = (
    await questions.question(`${question} (${choices.join('/')}) [${defaultValue}]: `)
  )
    .trim()
    .toLowerCase();
  if (!answer) return defaultValue;
  if ((choices as readonly string[]).includes(answer)) return answer as T;
  console.log(`Unknown choice "${answer}", using "${defaultValue}".`);
  return defaultValue;
}

function createQuestioner(): Questioner {
  if (!input.isTTY) {
    const answers = readFileSync(0, 'utf-8').split(/\r?\n/);
    return {
      question(prompt: string) {
        output.write(prompt);
        return Promise.resolve(answers.shift() ?? '');
      },
      close() {
        // no-op
      },
    };
  }

  const rl = createInterface({ input, output });
  return {
    question(prompt: string) {
      return questionLine(rl, prompt);
    },
    close() {
      rl.close();
    },
  };
}

function questionLine(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolveAnswer) => {
    rl.question(prompt, resolveAnswer);
  });
}

function detectStoreChoice(probe: ProjectProbe): InteractiveAnswers['stores'] {
  const hasPinia = Boolean(probe.deps.pinia);
  const hasVuex = Boolean(probe.deps.vuex);
  if (hasPinia && hasVuex) return 'both';
  if (hasPinia) return 'pinia';
  if (hasVuex) return 'vuex';
  return probe.hasStore ? 'both' : 'none';
}

function scanDir(dir: string, depth: number): string[] {
  if (depth <= 0) return [];
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        return scanDir(full, depth - 1);
      }
      if (entry.isFile()) return [entry.name];
      return [];
    });
  } catch {
    return [];
  }
}

function readPackageJson(cwd: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

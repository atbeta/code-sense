/**
 * Vue Plugin — Entity Definitions
 *
 * Declares entity types, framework APIs, and relationships
 * that the Vue plugin contributes to the graph engine.
 */
import type {
  EntityDefinition,
  FrameworkAPI,
  RelationshipDefinition,
} from '../../../types/config.js';

export const VUE_ENTITIES: Record<string, EntityDefinition> = {
  component: {
    patterns: ['**/*.vue'],
    properties: [
      { name: 'name', extract: 'component_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
      { name: 'isVue', extract: 'literal:true' },
    ],
    markers: [{ uses_options_api: false }, { naming_pattern: '*.vue' }],
    description: 'Vue single-file component',
  },

  composable: {
    patterns: ['composables/**/*.ts', 'composables/**/*.js'],
    properties: [
      { name: 'name', extract: 'file_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
      { name: 'isComposable', extract: 'literal:true' },
    ],
    description: 'Vue composable function module',
  },

  store: {
    patterns: ['stores/**/*.ts', 'stores/**/*.js', 'store/**/*.ts', 'store/**/*.js'],
    properties: [
      { name: 'name', extract: 'file_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
    ],
    description: 'Pinia or Vuex store module',
  },

  route: {
    patterns: ['router/**/*.ts', 'router/**/*.js', 'routes/**/*.ts', 'routes/**/*.js'],
    properties: [
      { name: 'name', extract: 'file_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
    ],
    description: 'Vue Router route definition file',
  },

  plugin: {
    patterns: ['plugins/**/*.ts', 'plugins/**/*.js'],
    properties: [
      { name: 'name', extract: 'file_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
    ],
    description: 'Vue plugin (app.use(...))',
  },

  layout: {
    patterns: ['layouts/**/*.vue'],
    properties: [
      { name: 'name', extract: 'file_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
    ],
    description: 'Vue layout component',
  },

  page: {
    patterns: ['pages/**/*.vue', 'views/**/*.vue'],
    properties: [
      { name: 'name', extract: 'file_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
    ],
    description: 'Vue page/route component',
  },

  mixin: {
    patterns: ['mixins/**/*.ts', 'mixins/**/*.js', 'mixins/**/*.vue'],
    properties: [
      { name: 'name', extract: 'file_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
    ],
    description: 'Vue component mixin (shared Options API logic)',
  },

  'electron-main': {
    patterns: ['electron/main.ts', 'electron/main.js', 'electron/index.ts', 'electron/index.js', 'src/main/**/*.ts', 'src/main/**/*.js'],
    description: 'Electron main process entry point',
  },

  preload: {
    patterns: ['electron/preload/**/*.ts', 'electron/preload/**/*.js', 'electron/preload.ts', 'electron/preload.js', 'src/preload/**/*.ts', 'src/preload/**/*.js'],
    properties: [
      { name: 'name', extract: 'file_name' },
      { name: 'filePath', extract: 'file_path' },
      { name: 'category', extract: 'file_category' },
    ],
    description: 'Electron preload script (contextBridge)',
  },
};

export const VUE_FRAMEWORK_APIS: FrameworkAPI[] = [
  {
    name: 'vue',
    sources: ['vue', 'vue/dist/vue.esm-bundler.js'],
    api_list: [
      'ref',
      'reactive',
      'computed',
      'watch',
      'watchEffect',
      'onMounted',
      'onUnmounted',
      'onBeforeMount',
      'onBeforeUnmount',
      'onUpdated',
      'onBeforeUpdate',
      'onActivated',
      'onDeactivated',
      'provide',
      'inject',
      'defineComponent',
      'defineAsyncComponent',
      'nextTick',
      'shallowRef',
      'shallowReactive',
      'toRef',
      'toRefs',
      'isRef',
      'unref',
      'triggerRef',
      'customRef',
      'markRaw',
      'toRaw',
      'readonly',
      'shallowReadonly',
      'useCssModule',
      'useCssVars',
      'useSlots',
      'useAttrs',
    ],
    compiler_macros: [
      'defineProps',
      'defineEmits',
      'defineExpose',
      'defineOptions',
      'defineSlots',
      'defineModel',
      'withDefaults',
    ],
  },
  {
    name: 'vue-router',
    sources: ['vue-router'],
    api_list: [
      'createRouter',
      'createWebHistory',
      'createWebHashHistory',
      'createMemoryHistory',
      'useRouter',
      'useRoute',
      'onBeforeRouteUpdate',
      'onBeforeRouteLeave',
    ],
  },
  {
    name: 'pinia',
    sources: ['pinia'],
    api_list: [
      'defineStore',
      'createPinia',
      'useStore',
      'storeToRefs',
      'setActivePinia',
      'getActivePinia',
      'setMapStoreSuffix',
    ],
  },
];

export const VUE_RELATIONSHIPS: Record<string, RelationshipDefinition> = {
  uses_store: {
    description: 'Component calls a Pinia/Vuex composable or action',
    from: 'component',
    to: 'store',
    detect_by: [
      { type: 'member_expression', pattern: '\\$store' },
      {
        type: 'call_expression',
        pattern: '/^use[A-Z]\\w+Store$/',
      },
    ],
  },

  route_to_component: {
    description: 'Route definition references a component',
    from: 'route',
    to: 'component',
    detect_by: [{ type: 'import_statement', pattern: '\\.vue$' }],
  },

  defines_composable: {
    description: 'Composable module exports composable functions',
    from: 'composable',
    to: 'composable',
    detect_by: [
      { type: 'export_default' },
      {
        type: 'export_statement',
        pattern: 'use[A-Z]\\w+',
      },
    ],
  },

  uses_mixin: {
    description: 'Component uses a mixin via mixins: [...] declaration (resolved in post-processing)',
    from: 'component',
    to: 'mixin',
    detect_by: [],
  },

  ipc_channel: {
    description: 'Main process handles an IPC channel that renderer calls',
    from: 'electron-main',
    to: 'electron-main',
    detect_by: [
      { type: 'call_expression', pattern: 'ipcMain.handle' },
      { type: 'call_expression', pattern: 'ipcMain.on' },
    ],
  },

  exposes_ipc: {
    description: 'Preload script exposes IPC methods to renderer',
    from: 'preload',
    to: 'preload',
    detect_by: [
      { type: 'call_expression', pattern: 'contextBridge.exposeInMainWorld' },
    ],
  },

  calls_ipc: {
    description: 'Renderer calls IPC through preload bridge or direct invoke',
    from: 'component',
    to: 'electron-main',
    detect_by: [
      { type: 'call_expression', pattern: 'ipcRenderer.invoke' },
      { type: 'call_expression', pattern: 'ipcRenderer.send' },
      { type: 'member_expression', pattern: 'window.*' },
    ],
  },
};

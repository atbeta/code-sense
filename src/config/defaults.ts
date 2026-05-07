import type { CodeSenseConfig } from '../types/config.js';

/**
 * Minimal default config. The user's codesense.yaml overrides these.
 * Serves as documentation of all recognized fields.
 */
export const DEFAULT_CONFIG: Partial<CodeSenseConfig> = {
  framework_apis: [],
  relationships: {},
};

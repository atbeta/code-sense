#!/usr/bin/env node

import { Command } from 'commander';
import { resolve, sep } from 'node:path';
import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import { loadConfig, resolveSourceRoot } from './config/loader.js';
import { buildGraph } from './graph/builder.js';
import { startMCPServer } from './mcp/server.js';
import { startVisServer } from './vis/server.js';

const program = new Command();

program
  .name('codesense')
  .description('Config-driven code knowledge graph for Vue projects')
  .version('0.1.0');

program
  .command('index')
  .description('Build the code knowledge graph for a project')
  .option('-c, --config <path>', 'Path to codesense.yaml', 'codesense.yaml')
  .option(
    '-o, --output <path>',
    'Output path for the KuzuDB graph',
    '.codesense/graph',
  )
  .action(async (options) => {
    const configPath = resolve(process.cwd(), options.config);
    const outputPath = resolve(process.cwd(), options.output);

    console.error(`[CodeSense] Loading config: ${configPath}`);
    const config = loadConfig(configPath);
    const sourceRoot = resolveSourceRoot(config, process.cwd());

    console.error(`[CodeSense] Project: ${config.project.name}`);
    console.error(`[CodeSense] Source root: ${sourceRoot}`);
    console.error(
      `[CodeSense] Entity types: ${Object.keys(config.all_entities).join(', ')}`,
    );
    console.error(`[CodeSense] Building graph...`);

    const startTime = Date.now();
    const result = await buildGraph(config, sourceRoot, outputPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.error(`[CodeSense] Done in ${elapsed}s`);
    console.log(
      JSON.stringify(
        {
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          entityTypes: Object.keys(config.all_entities),
          outputPath,
        },
        null,
        2,
      ),
    );
  });

program
  .command('serve')
  .description('Start the MCP server (stdio by default, HTTP with --port)')
  .option('-c, --config <path>', 'Path to codesense.yaml', 'codesense.yaml')
  .option(
    '-o, --output <path>',
    'Path to the KuzuDB graph',
    '.codesense/graph',
  )
  .option('-p, --port <number>', 'Run as HTTP server on the given port', parseInt)
  .action(async (options) => {
    const configPath = resolve(process.cwd(), options.config);
    const outputPath = resolve(process.cwd(), options.output);

    await startMCPServer(configPath, outputPath, options.port);
  });

program
  .command('view')
  .description('Start the graph visualization server')
  .option('-o, --output <path>', 'Path to the graph database', '.codesense/graph')
  .option('-p, --port <number>', 'HTTP server port', '3456')
  .action(async (options) => {
    const outputPath = resolve(process.cwd(), options.output);
    const port = parseInt(options.port, 10);
    await startVisServer(outputPath, port);
    console.error(`[CodeSense] Press Ctrl+C to stop`);
  });

program
  .command('init')
  .description('Create a default codesense.yaml in the current directory')
  .action(() => {
    const cwd = process.cwd();
    const srcDir = resolve(cwd, 'src');
    const projectName = cwd.split(sep).pop() ?? 'my-project';

    // Probe the project: JS or TS? Which directories exist?
    let ext = 'ts';
    if (existsSync(srcDir)) {
      const scanDir = (dir: string, depth: number): string[] => {
        if (depth <= 0) return [];
        try {
          return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const full = resolve(dir, e.name);
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
              return scanDir(full, depth - 1);
            if (e.isFile()) return [e.name];
            return [];
          });
        } catch { return []; }
      };
      const files = scanDir(srcDir, 3);
      const tsCount = files.filter((f) => f.endsWith('.ts')).length;
      const jsCount = files.filter((f) => f.endsWith('.js')).length;
      if (jsCount > tsCount) ext = 'js';
    }

    const storeDir = existsSync(resolve(srcDir, 'store')) ? 'store' : 'stores';
    const storePattern = `src/${storeDir}/**/*.{js,ts}`;
    const routerPattern = `src/router/**/*.{js,ts}`;

    const defaultConfig = `# CodeSense configuration — minimal starter
# Only project.name + entities are required. Everything else is optional.

project:
  name: "${projectName}"
  source_root: "src"

entities:
  component:
    patterns:
      - "**/*.vue"
  store:
    patterns:
      - "${storePattern}"
  route:
    patterns:
      - "${routerPattern}"
`;

    const targetPath = resolve(cwd, 'codesense.yaml');
    if (existsSync(targetPath)) {
      console.error(`codesense.yaml already exists at ${targetPath}`);
      process.exit(1);
    }
    writeFileSync(targetPath, defaultConfig, 'utf-8');
    console.log(`Created codesense.yaml at ${targetPath}`);
    console.error(`[CodeSense] Detected file extension: .${ext}`);
    console.error(`[CodeSense] Store pattern: ${storePattern}`);
    console.error(`[CodeSense] Router pattern: ${routerPattern}`);
  });

program.parse();

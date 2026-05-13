# CodeSense

[中文](README.md) | [English](README.en.md)

面向 Vue 项目的配置驱动代码知识图谱引擎。基于 tree-sitter AST 解析、LadybugDB 图数据库、MCP 协议与 Sigma.js 可视化。

灵感来自 [GitNexus](https://github.com/abhigyanpatwari/GitNexus)，并针对 Vue 语义做了增强。

## 快速开始

```bash
# 初始化配置
npx @code-sense/core init

# 交互式初始化（包含 Vue / Electron 常见选项）
npx @code-sense/core init --interactive

# 建立知识图谱索引
npx @code-sense/core index

# 浏览图谱可视化
npx @code-sense/core view

# 作为 MCP 服务接入 AI 编码助手
npx @code-sense/core serve
```

全局安装：

```bash
npm install -g @code-sense/core
code-sense init
```

## 核心能力

- 将 `.vue` 组件、store、路由等实体构建为图节点
- 将 import、store 调用、路由映射等关系构建为图边
- 识别 Vue API 调用（如 `ref`、`computed`、`watch`）
- 提供 MCP 工具支持影响分析、调用追踪、语义检索等
- 提供浏览器图谱视图（Sigma.js）用于交互探索

## 命令

| 命令 | 说明 |
| --- | --- |
| `index` | 构建知识图谱 |
| `view` | 启动可视化服务（默认端口 `3456`） |
| `serve` | 启动 MCP 服务供 AI Agent 调用 |
| `init` | 生成默认 `codesense.yaml` |
| `init --interactive` | 生成更完整的项目配置 |

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `entity_context` | 获取文件/实体的完整上下文 |
| `function_context` | 查看函数调用方、被调用方与同级函数 |
| `impact_analysis` | 分析改动影响范围 |
| `diff_impact` | 基于 Git diff 的影响追踪 |
| `route_map` | 路由与组件映射 |
| `trace_usage` | 符号使用位置与证据 |
| `find_entrypoints` | 识别入口点（路由、页面等） |
| `semantic_search` | 语义检索函数/代码片段 |
| `project_overview` | 项目图谱统计总览 |
| `cypher` | 执行原生 Cypher 调试查询 |

## MCP 配置示例（Claude Code / Codex）

```json
{
  "mcpServers": {
    "code-sense": {
      "command": "npx",
      "args": ["@code-sense/core", "serve"]
    }
  }
}
```

不要在 MCP 配置中写死绝对路径，避免多个项目误连到同一个图谱数据目录。

## 许可证

MIT

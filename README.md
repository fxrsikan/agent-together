# Loom（暂定名）

AI 编码 agent 的画布控制台：人在画布上表达意图，agent 按节点领任务，观察者实时检查是否跑偏。
设计文档：<https://claude.ai/artifact/VHLouGg6CnmTdgnDqKVVBT>

> 产品名待定："Loom" 与 Atlassian 的产品同名，开源发布前会改名。

## 当前状态：v0.1 骨架

已跑通一条线：**Claude Code hook → loom-hook → 本地守护进程 → 观察者规则 → 裁决回给 Claude Code，同时显示在画布上。**

| 已有 | 说明 |
| --- | --- |
| 画布数据格式 | `.loom/canvas/<节点>.json` + `_edges.json`，zod 校验 |
| 观察者 L0 规则 | 越界写入、设计守护（import 必须沿画布连线）、篡改测试、重复失败、重复读取 |
| 生成初始画布 | `loom-init`：按顶层目录（monorepo 按子包）建节点，按 import 关系连线 |
| 检查点与回滚 | 派发前自动保存，可一键回滚；快照存为 `refs/loom/checkpoints/*`，不碰分支和暂存区，回滚本身可撤销 |
| 记忆 | 每轮结束时观察者的拦截生成草稿，人工批准后进入派发上下文，并同步到项目 `CLAUDE.md` 的 Loom 区块；也可手动添加 |
| L2 语义判断（v0.2） | 每轮结束后在后台运行，不拖慢 agent：把记忆草稿提炼成一句中文经验（原始记录保留为 evidence）；对照节点目标和派发任务判断这一轮是否跑偏，结果显示在画布信号灯和"L2 定向判断"中 |
| 能力单元（v0.2） | `.loom/capabilities/<id>.md` 写一次，编译到各平台：skill → `.claude/skills/`、`.agents/skills/`（Codex、Grok Build 等开放标准）、`.cursor/rules/*.mdc`；agent 角色 → `.claude/agents/`；observer（范围 + 禁止出现的正则）由 Loom 观察者对所有 agent 执行。编译前校验，节点可"导出为能力单元"，内容变化时自动升版本 |
| 派发任务 | 选中节点 → 填任务 → 生成节点邻域上下文 `.loom/context/<节点>.md`，在新终端窗口启动 Claude Code（v0.1 仅 Windows） |
| 干预 | `ask` 让 Claude Code 询问用户，`block` 拒绝，`warn` 注入提醒 |
| Claude Code 适配器 | hook 载荷 ↔ 统一事件，写入 `.claude/settings.local.json` |
| Codex 适配器（v0.2） | 解析 `apply_patch`（一个补丁多个文件各自检查），`ask` 转为拒绝并要求 agent 询问用户，退出码从会话记录读取；hooks 写入 git 仓库根目录的 `.codex/hooks.json`，需在 Codex 的 `/hooks` 中信任 |
| 桌面应用 | Electron + React Flow：画布、节点信号灯、当前节点、事件流 |

## 目录

```
packages/schema               画布、事件、裁决的类型与校验
packages/core                 .loom 存储、观察者规则、本地守护进程（loom-daemon）
packages/adapter-claude-code  Claude Code hook 载荷转换与安装
packages/hook                 loom-hook：hook 调用的小程序，守护进程不在时放行
apps/desktop                  桌面应用
examples/demo                 示例项目（登录表单 → 用户服务 → 数据库）
```

## 开始

需要 Node 22+。

```bash
npm install
npm run build
npm test
npm run dev
```

给自己的项目生成画布（之后再改节点名称、目标和连线）：

```bash
node packages/core/dist/init-cli.js <你的项目目录>
```

`npm run dev` 默认打开 `examples/demo`；设置环境变量 `LOOM_PROJECT` 可打开其他带 `.loom/` 的项目。

在应用里点"安装 Claude Code hooks"，选中节点后点"设为当前节点"，然后在该项目目录里运行 Claude Code。
不开桌面应用时也可以只跑守护进程：

```bash
node packages/core/dist/cli.js examples/demo login-form
```

给 Codex 安装 hooks（之后在项目里运行 `codex`，用 `/hooks` 信任它们）：

```bash
node packages/hook/dist/loom-hook.js install <你的项目目录> --platform codex
```

编译能力单元：

```bash
node packages/hook/dist/loom-compile.js <你的项目目录>
```

观察规则示例（`.loom/capabilities/no-console-log.md`）：

```markdown
---
id: no-console-log
kind: observer
description: "Use when writing auth code: no console.log in src/auth"
scope: ["src/auth/**"]
forbid: "console\\.log"
level: ask
---
认证代码里不许留 console.log（会泄露邮箱等敏感信息），需要日志请用 logger。
```

## L2 模型

默认 `auto`：设置了 `ANTHROPIC_API_KEY` 时用 Claude API（`claude-haiku-5-5`），否则用已登录的 `claude` 命令行（Haiku），都没有则关闭 L2、只跑 L0 规则。可在 `.loom/llm.json` 中指定（不要写密钥）：

```json
{ "provider": "claude-cli", "maxCallsPerSession": 20 }
```

`provider` 可选 `auto` / `off` / `anthropic` / `claude-cli` / `openai-compatible`（另需 `baseUrl`、`model`，如本地 Ollama 的 `http://localhost:11434/v1`；密钥放环境变量 `LOOM_LLM_API_KEY`）。环境变量 `LOOM_LLM_PROVIDER` 可临时覆盖。

## 规则级别

在 `.loom/rules.json` 中按规则设置：`off` / `log` / `warn` / `ask` / `block`。

## 协议

Apache-2.0

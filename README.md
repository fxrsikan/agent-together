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
| 派发任务 | 选中节点 → 填任务 → 生成节点邻域上下文 `.loom/context/<节点>.md`，在新终端窗口启动 Claude Code（v0.1 仅 Windows） |
| 干预 | `ask` 让 Claude Code 询问用户，`block` 拒绝，`warn` 注入提醒 |
| Claude Code 适配器 | hook 载荷 ↔ 统一事件，写入 `.claude/settings.local.json` |
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

`npm run dev` 默认打开 `examples/demo`；设置环境变量 `LOOM_PROJECT` 可打开其他带 `.loom/` 的项目。

在应用里点"安装 Claude Code hooks"，选中节点后点"设为当前节点"，然后在该项目目录里运行 Claude Code。
不开桌面应用时也可以只跑守护进程：

```bash
node packages/core/dist/cli.js examples/demo login-form
```

## 规则级别

在 `.loom/rules.json` 中按规则设置：`off` / `log` / `warn` / `ask` / `block`。

## 协议

Apache-2.0

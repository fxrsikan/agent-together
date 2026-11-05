# Agent Together

**说出你想做什么，AI 画出计划，一群 AI 分头去做；有人盯着它们不跑偏，越用越聪明。**

不会写代码也能用 AI 做出能跑的项目。Agent Together 把你的想法画成一张画布：每张卡片是一块活，连线是先后顺序。AI 编程助手（Claude Code、Codex、Cursor、Grok Build，用哪个都行）按卡片一块一块地做；旁边的观察者盯着它们，谁想动不归自己管的东西就当场拦下；每做完一块自动跑测试，坏了就交给负责那块的 AI 去修。

## 为什么需要它

AI 写代码很快，但做着做着容易跑偏：让它改购物车，它顺手把登录页也改了；测试不过，它去改测试而不是改代码；新开一次对话，之前定好的规矩全忘了。

现在已经有很多工具能让几个 AI 同时干活，但它们只管"开工"，不管"按计划干"。各家 AI 公司也只会管好自家的助手。Agent Together 做的是它们之上的那一层：**一份计划，所有 AI 都得遵守。**

## 怎么用

1. **说想法**：新建项目，写一段话，比如"做一个命令行记账工具，能记收支、按月统计"。
2. **看计划**：点"AI 生成画布"，AI 把想法拆成几张卡片，标好每张做什么、负责哪些文件、依赖谁。不满意可以直接在画布上改。
3. **让 AI 干活**：点一张卡片，选一个 AI 助手，点「交给 AI 去做」。它干活的过程实时显示在应用里。
4. **看结果**：做完自动跑测试。
   - 通过了：自动存一个检查点，点"标记为完成"，接着做下一张。
   - 没通过：一键把失败交回给 AI；如果坏的是别的卡片负责的部分，就交给那张卡片去修。
   - 越做越乱：一键回到上一个检查点重来。

卡片上的信号灯告诉你现在怎么样：顺利、被拦了一次、需要你看一下。

## 现在能做什么

**已经能用（v1）**

- 新建或打开项目，AI 生成画布，在画布上增删改卡片和连线
- 在应用里把活交给 Claude Code、Codex、Cursor，实时看 AI 的输出（Grok Build 也支持，但还没在应用里完整跑通）
- 观察者：拦下越界修改、违反依赖、篡改测试、原地打转；跑完后再查一遍所有改动，用命令行绕过去的也能发现
- 每次做完自动跑测试，失败交给负责的卡片修复，通过自动存检查点
- 记忆：AI 犯过的错整理成经验，你批准后，以后每次交给 AI 都会带上
- 同一张卡片让几个 AI 比赛，按测试结果和越界情况打分，选最好的那个
- 开工前可以看到、也可以修改要交给 AI 的全部内容
- 进化（用 Claude Haiku 实测过一次）：卡片反复失败时，同一个助手在独立工作区试两到三种做法，和原来的方式比测试、越界和改动大小；你点"同意"才会记住，也可以一起采用代码。在两个不同项目里都有效的做法，新项目生成画布后会提示你。方法参考了 Google Research 的 [Harness²](https://github.com/google-research/harness2)
- 专职角色：规划时按需提出角色草稿（界面设计员、测试员……），也可以用一句话让 AI 写一个；你看过、改过、同意后才保存。把角色拖到画布空白处就多一步，拖到卡片上就交给它做，交给 AI 时会带上角色的工作说明
- 安装向导：第一次打开（以后在启动页也能打开）会检查 Node.js 22+、git 和四个 AI 助手的命令行装好没有、登录没有；缺什么就给出你电脑上的安装命令，装好后点"再检查一次"
- 界面上的提示都是大白话（卡片、交给 AI 去做……），不出现 hook、规则编号这类术语

用这一版从零做出了一个命令行待办工具：7 张卡片，91 个测试全部通过，模型花费约 0.08 美元。

**用数据说话**

同一组故意诱惑 AI 越界的任务，开、关观察者各跑 12 次：Cursor 只拿到卡片说明时 67% 的运行改了别的卡片的文件，开着观察者时 0%；按"测试通过且没越界"算，完成率从 33% 升到 75%。Claude Haiku 有卡片说明就基本守规矩（越界 8% → 0%）。Codex 的观察者在命令行模式下接不上（要先在 Codex 里手动信任 hook），Grok Build 这次碰到免费额度上限，两者都还没有有效数据。详见 [bench/README.md](bench/README.md)。

**还没做好**

- Codex：命令行模式下要先在 Codex 自己的界面里信任 hook，观察者才能实时拦；赛马、进化和评测里都还接不上
- Grok Build：应用里能派发，但还没完整跑通过

## 开始

**Windows**：下载 `AgentTogether-Setup-<版本>.exe`，双击安装。安装包还没有签名，Windows 可能提示"已保护你的电脑"，点"更多信息"→"仍要运行"。macOS 和 Linux 的安装包还没有做，请先用下面的方式从源码运行。

**从源码运行**（开发者）：

```bash
npm install
npm run build
npm run dev
```

自己打 Windows 安装包：`npm run build && npm run dist -w @agent-together/desktop`，生成在 `apps/desktop/release/`。

第一次打开应用会进入**安装向导**：检查 [Node.js 22+](https://nodejs.org)、[git](https://git-scm.com)，以及至少一个 AI 编程助手（[Claude Code](https://claude.com/claude-code)、Codex、Cursor 或 Grok Build 的命令行）是否装好、登录好。之后也可以在启动页再打开向导。

都好了之后，在启动页填项目名、选位置、写一段想法，点"创建"，然后按上面"怎么用"的四步走。已有代码的文件夹用"打开文件夹…"，第一次打开会按目录结构自动生成画布。

---

## 给开发者

### 它是怎么工作的

各家 AI 助手在动手之前会调用项目里配置的 hook。Agent Together 把这些 hook 指向一个小程序 `agent-together-hook`，由它去问本地守护进程，守护进程按画布和规则判断后，回复"放行""拦下"或"先问用户"，同时把结果显示在画布上。

所有状态都是项目里 `.agent-together/` 下的文件，可以 diff，也可以随 git 共享：

```
.agent-together/
  canvas/        画布节点（每个节点一个 JSON）与 _edges.json
  rules.json     观察者规则级别
  memory/        记忆条目
  capabilities/  能力单元
  project.json   产品描述、技术栈、测试命令
  race.json      赛马设置
  llm.json       L2 判断用的模型
  events/        事件日志（不提交）
```

### 功能细节

| 功能 | 说明 |
| --- | --- |
| 专职角色 | 规划时提出 0–4 个角色，或用一句话生成草稿；同意后保存并编译。拖进画布使用，也可在节点编辑器选择或取消角色。没有可用模型时会提示配置。 |
| 观察者 L0 规则 | 越界写入、设计守护（import 必须沿画布连线）、篡改测试、重复失败、重复读取。级别在 `rules.json` 里按规则设：`off` / `log` / `warn` / `ask` / `block` |
| L2 语义判断 | 每轮结束后在后台运行：把记忆草稿提炼成一句经验，对照节点目标判断这一轮是否跑偏 |
| 应用内运行 | Claude Code、Cursor 用 `--output-format stream-json`，Codex 用 JSONL，输出实时显示；结束后跑项目测试，并从测试输出找出失败文件属于哪个节点 |
| 事后检查 | hook 只能看到 AI 用改文件工具做的修改。每次跑完、跑测试之前，把派发前检查点以来的所有改动再过一遍观察者规则，用命令行或脚本改的也算；观察者当场没看到的会标出来 |
| 检查点与回滚 | 派发前和测试通过时自动保存，存为 `refs/agent-together/checkpoints/*`，不碰分支和暂存区，回滚本身可撤销 |
| 记忆 | 拦截生成草稿，批准后进入派发上下文，并同步到 `CLAUDE.md` 的 Agent Together 区块 |
| 能力单元 | `.agent-together/capabilities/<id>.md` 写一次，编译到各平台：skill → `.claude/skills/`、`.agents/skills/`、`.cursor/rules/*.mdc`；agent 角色 → `.claude/agents/`；observer 由 Agent Together 对所有 agent 执行 |
| 多 agent 赛马 | 同一节点、同一起点，各 agent 在独立 git worktree 里并行跑；按测试、观察者回放、改动大小打分；采用前自动存检查点 |
| 进化 | 卡片连续两次测试失败会提示，也能手动发起；含对照组、测试优先排名、分数明细和费用；同意后记住，报告保存在 `.agent-together/evolutions/`。跨项目经验保存在 `~/.agent-together/experience/`，可用 `AGENT_TOGETHER_EXPERIENCE_DIR` 改位置 |
| 上下文检查器 | 派发前查看完整上下文、token 估算和每一节的占比，可以去掉某条记忆或直接改文字 |
| Claude Code | hooks 写入 `.claude/settings.local.json` |
| Codex | 解析 `apply_patch`，一个补丁里的每个文件分别检查；hooks 写入 git 根目录的 `.codex/hooks.json`，需在 Codex 的 `/hooks` 中信任 |
| Cursor | hooks 写入项目和 git 根目录的 `.cursor/hooks.json`；还原 Windows 上 PowerShell 按 GBK 转码造成的中文乱码；回复一律用 ASCII；从 Git Bash 启动时去掉 `SHELL`、`MSYSTEM`（否则 cursor-agent 会用 bash 跑 PowerShell hook）。命令行的 `-p` 模式不发"一轮结束"事件，不会生成记忆草稿 |
| Grok Build | 读取 Claude Code 的 hooks；适配器识别 Grok 的工具名（`search_replace`、`write`、`read_file`、`run_terminal_command`），事件标记为 grok-build |

### 代码目录

```
packages/schema               画布、事件、裁决的类型与校验
packages/core                 存储、观察者规则、守护进程、规划、测试、赛马
packages/adapter-claude-code  Claude Code（含 Grok Build）hook 转换与运行
packages/adapter-codex        Codex
packages/adapter-cursor       Cursor
packages/adapter-grok         Grok Build 运行
packages/hook                 agent-together-hook、-compile、-race 命令
apps/desktop                  桌面应用（Electron + React Flow）
examples/demo                 示例项目
```

测试：`npm test`（vitest）。

### 命令行

启动时直接打开某个项目：设置环境变量 `AGENT_TOGETHER_PROJECT=<目录>`。

按目录结构生成画布：

```bash
node packages/core/dist/init-cli.js <项目目录>
```

不开桌面应用、只跑守护进程（之后在该目录里运行 agent）：

```bash
node packages/core/dist/cli.js <项目目录> <当前节点id>
```

给 Cursor 或 Codex 安装 hooks：

```bash
node packages/hook/dist/agent-together-hook.js install <项目目录> --platform cursor
```

```bash
node packages/hook/dist/agent-together-hook.js install <项目目录> --platform codex
```

编译能力单元：

```bash
node packages/hook/dist/agent-together-compile.js <项目目录>
```

观察规则示例（`.agent-together/capabilities/no-console-log.md`）：

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

赛马（测试命令写在 `project.json` 或 `race.json` 的 `testCommand`）：

```bash
node packages/hook/dist/agent-together-race.js <项目目录> <节点id> "任务描述" --agents claude-code,codex,cursor --claude-model haiku
```

```bash
node packages/hook/dist/agent-together-race.js adopt <项目目录> <赛马id> <claude-code|codex|cursor>
```

进化（需要可用的 L2 模型和 git 仓库，会运行多次助手）：

```bash
node packages/hook/dist/agent-together-evolve.js <项目目录> <节点id> "任务描述" codex
node packages/hook/dist/agent-together-evolve.js list <项目目录>
node packages/hook/dist/agent-together-evolve.js approve <项目目录> <进化id>
# 同意并采用代码（先存检查点）：在上一条命令末尾加 --adopt
node packages/hook/dist/agent-together-evolve.js discard <项目目录> <进化id>
```

桌面里选中一张卡片，在“进化”里选助手并开始。没有配置模型时会说明；没有测试命令时不会把做法算作有效。每次比较只跑一次，结果仍需你查看后同意。

### L2 模型

默认 `auto`：设置了 `ANTHROPIC_API_KEY` 时用 Claude API（`claude-haiku-5-5`），否则用已登录的 `claude` 命令行（Haiku），都没有则只跑 L0 规则。也可以在 `.agent-together/llm.json` 中指定（不要在里面写密钥）：

```json
{ "provider": "claude-cli", "maxCallsPerSession": 20 }
```

`provider` 可选 `auto` / `off` / `anthropic` / `claude-cli` / `openai-compatible`。选 `openai-compatible` 时另需 `baseUrl` 和 `model`，比如本地 Ollama 的 `http://localhost:11434/v1`；密钥放在环境变量 `AGENT_TOGETHER_LLM_API_KEY`。环境变量 `AGENT_TOGETHER_LLM_PROVIDER` 可以临时覆盖。

## 协议

Apache-2.0

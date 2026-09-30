# Codex × DSH MCP

**让 Codex 的 Sol 级模型做指挥，让 DeepSeek Flash 做编程主力，GLM、Qwen、Kimi 按任务协作。**

一个轻量的本地 MCP 桥接，把 Codex 的规划能力和 DeepSeek Harness（DSH）的多模型执行能力接起来。当前版本 **v1.1.1**。

你在 Codex 中交代目标，Sol 模型理解需求、划分任务、确定接口，再通过 MCP 在 DSH 中建立独立聊天，把具体工作交给合适的模型。结果回到 Codex，由主控检查关键边界、整合改动并向你汇报。

## 为什么这样分工

架构决策和局部实现对模型的要求不同。项目采用以下分工策略，把主控额度集中在需求理解、跨模块判断和最终整合，把大量范围明确的编程工作交给执行模型。

| 角色 | 模型 | 本项目中的分工 |
| --- | --- | --- |
| 指挥 / 架构师 | Codex 中的 Sol 级模型，例如 GPT-6.1-Sol | 澄清目标、拆任务、定义输入输出、安排依赖、审查关键变更、整合交付 |
| 主力程序员 | DeepSeek Flash | 明确边界的功能实现、局部修复、代码修改和调试；作为默认执行选择 |
| 协作成员 | GLM | 承接独立实现，或对具体方案和改动给出第二视角 |
| 协作成员 | Qwen | 按任务处理脚本、文本整理、文档及独立代码工作 |
| 可选成员 | Kimi | 按任务阅读材料、整理上下文，或执行其他独立工作 |

这是项目的使用策略，不是模型能力排行榜。实际派工取决于可用模型、项目需求和执行反馈；本项目没有提供模型横向评测或额度节省比例。

```mermaid
flowchart TD
    U[用户：目标与约束] --> C[Codex / Sol：拆解、指挥、整合]
    C --> M[本地 MCP 桥接]
    M --> D[DSH / DeepSeek Flash：主力编程]
    M --> G[DSH / GLM：协作任务]
    M --> Q[DSH / Qwen：协作任务]
    M --> K[DSH / Kimi：可选任务]
    D --> R[会话状态与回复]
    G --> R
    Q --> R
    K --> R
    R --> C
    C --> O[交付结果]
```

## 已实现的能力

当前的指挥工作由 Codex 对话中的主控模型完成，MCP 提供执行接口。可以创建多个独立 DSH 聊天、指定模型和推理强度、发送任务、读取结果以及补充指令。不同聊天保留各自的模型选择，MCP 不修改 DSH 全局默认模型。

自动任务路由、持久任务队列、无人值守调度、自动合并代码和角色之间自主对话尚未实现。多个聊天操作同一目录时，应由主控安排文件边界；存在冲突风险的任务使用不同目录或 Git worktree。

### 八个 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `dsh_info` | 查看桥接状态、模型 ID 和各模型支持的推理强度 |
| `dsh_chat` | 创建空聊天或立即发任务；选择项目、模型、推理强度；继续聊天或插队补充要求 |
| `dsh_result` | 读取状态与文本回复，省略推理过程和工具日志 |
| `dsh_projects` | 列出 DSH 项目 |
| `dsh_project_create` | 创建目录并注册项目，也可使用已有目录 |
| `dsh_project_delete` | 移除项目注册，保留磁盘文件与聊天记录 |
| `dsh_chats` | 查看聊天 ID、标题、目录及归档状态，可按项目筛选 |
| `dsh_chat_archive` | 归档聊天并保留历史；运行中默认拒绝，可显式指定 `stop_activity: true` |

## 快速安装

### 前提

- Node.js `>=22.19.0`、npm，以及带 MCP 支持的 Codex。
- 能正常启动的 DSH。已在 Windows 上验证官方 DeepSeek Harness 的连接、发送任务、读取回复和归档流程。
- DSH 中已经配置可用模型和相应凭据。本仓库不附带模型服务或凭据。

### 1. 下载并安装依赖

```powershell
git clone https://github.com/guochengran464-byte/codex-dsh-mcp.git
cd codex-dsh-mcp
npm ci
Copy-Item config.example.json config.json
```

编辑本机 `config.json`，填入绝对路径。例如：

```json
{
  "port": 43129,
  "stateDir": "D:/agent-work/dsh-mcp-state",
  "defaultCwd": "D:/agent-work/dsh-workers"
}
```

`stateDir` 放桥接密钥；`defaultCwd` 是未指定项目或目录时，执行聊天使用的工作目录。`config.json` 已加入 Git 忽略规则。

### 2. 初始化目录和桥接密钥

首次安装时，在仓库目录执行以下 PowerShell 命令。密钥直接写入本机文件，不打印到终端；已有密钥时拒绝覆盖。

```powershell
@'
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
const config = JSON.parse(await readFile('config.json', 'utf8'));
await mkdir(config.stateDir, { recursive: true });
await mkdir(config.defaultCwd, { recursive: true });
await writeFile(join(config.stateDir, 'token'), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
'@ | node --input-type=module
```

### 3. 在 DSH 中加载桥接插件

在实际使用的 Profile 的 `cordis.patch.yml` 末尾追加以下条目。桌面版通常使用 `~/.dsh/profiles/desktop/cordis.patch.yml`，以实际 Profile 为准。

把 `name` 替换为本仓库 `dsh-plugin.mjs` 的绝对路径，其他配置保持与 `config.json` 一致。Windows YAML 路径建议使用 `/`。

```yaml
# BEGIN CODEX DSH MCP
- insert:
    - id: codex-dsh-mcp
      name: "D:/agent-work/codex-dsh-mcp/dsh-plugin.mjs"
      config:
        port: 43129
        allowedProviders: ["your-provider-id"]
        stateDir: "D:/agent-work/dsh-mcp-state"
        defaultCwd: "D:/agent-work/dsh-workers"
# END CODEX DSH MCP
```

`allowedProviders` 填入你允许 MCP 使用的实际提供方 ID（可在 DSH 模型配置中查看），不要照抄示例值。未配置白名单时插件拒绝启动；只读取并调用白名单内的提供方，不会自动回退。

重启 DSH，保持它运行。

### 4. 注册到 Codex

```powershell
codex mcp add dsh -- node "D:/agent-work/codex-dsh-mcp/server.mjs"
```

替换为实际仓库路径。重新打开 Codex 后，调用 `dsh_info` 确认 `connected: true`，并查看当前可用模型。

## 给主控的示例指令

在 Codex 中选择你要使用的 Sol 级模型，再粘贴下面的指令，并补上实际任务：

> 你负责架构、任务拆解和最终整合。先通过 dsh_info 读取模型目录。范围明确的编程任务默认交给 DeepSeek Flash；适合独立推进的工作可分给 GLM、Qwen 或 Kimi。按模型实际支持的档位选择推理强度。
>
> 每项任务交代目标、工作目录、允许修改的文件、输入输出、验收要求和需要返回的结果。存在依赖时先完成前置任务；并行工作划分文件边界，必要时使用独立目录。通过 dsh_chat 建立聊天并派工，记录 session_id 和 after_seq，再用 dsh_result 收集结果。
>
> 有补充要求时使用 mode: steer 插队；普通后续任务使用 queue。遇到权限请求就告知我。审查重点放在任务边界、接口、结果与明显风险，避免重复审查已解决的问题。汇总改动和仍需处理的事项。
>
> 我的任务是：……

### 创建主力编程聊天

传给 `dsh_chat`：

```json
{
  "title": "主力：实现登录接口",
  "model": "deepseek-flash",
  "reasoning_effort": "default",
  "cwd": "D:/agent-work/my-project",
  "prompt": "实现登录接口。只修改 src/auth 下的文件。先阅读现有接口约定，完成后返回修改文件、行为变化和未解决的问题。"
}
```

协作聊天可使用已配置提供方下的模型，例如 `glm-5.3`、`qwen3.8-flash`、`kimi-k3`。模型 ID 与档位可能变化，始终以 `dsh_info` 的实时目录为准。

### 读取结果与继续工作

`dsh_chat` 立即返回 `session_id` 和 `after_seq`。将它们传给 `dsh_result`，状态为 `running` 时稍后再读取。`after_seq` 用于排除早先的回复。

省略 `prompt` 会创建空聊天，不发送模型请求。传 `project_id` 可以把新聊天放入已有 DSH 项目，与 `cwd` 二选一。

模型、推理强度、项目、目录和名称参数仅用于新聊天；继续聊天时传 `session_id`、`prompt` 和可选 `mode`。归档后的聊天需要先在 DSH 中恢复。

### 排队与插队

```json
{
  "session_id": "dsh_chat 返回的会话 ID",
  "prompt": "补充要求：接口需要保持向后兼容，先处理这个约束。",
  "mode": "steer"
}
```

`mode: "queue"` 是默认行为，等待当前轮完成；`"steer"` 使用 DSH 原生插队机制，把补充指令交给当前轮。接入时机由 DSH 决定，不保证立即取消正在进行的模型请求或工具调用。

### 推理强度

使用 `dsh_info` 返回的 `reasoning.efforts[].id`。`reasoning_effort: "default"` 使用模型自身默认强度；省略所有模型选项时沿用 DSH 当前默认选择。传入不支持的值会报错，不会静默替换模型或提供方。

## 连接方式与边界

### 官方入口调查

官方提供的自动化入口是本地子进程加 stdio 协议，不是公开 HTTP REST API：

| 入口 | 官方说明 | 能力与边界 |
| --- | --- | --- |
| [`dsh --profile headless "任务"`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.zh.md) | 一次性任务；可用 `--json` 和 `--session-id` | 无 GUI、无服务端口；单次执行后退出 |
| [`dsh --profile acp`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.zh.md) | 标准 ACP v1 stdio 服务 | 多个持久会话；新建/列出/恢复/关闭会话，选择模型与推理强度，发送/取消任务并接收状态和回复；不支持 `mode`、归档、删除、fork 或 transcript 回放 |
| [`dsh --profile sdk`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md) | DSH SDK 的 JSON-RPC stdio 服务 | 初始化模型路由，排队提示词并推送会话事件/状态；比 ACP 少会话管理能力 |
| 桌面版 Web/Host | 运行时本机 HTTP 服务 | 不是公开控制 API；未认证请求受保护 |

本机实测：桌面安装目录内有 `resources/runtime/cli/bin/dsh.cmd`，不在系统 PATH；`dsh --version` 返回 `0.2.0-rc.2`。`netstat -ano` 显示 DSH 进程在 `127.0.0.1:19387`（桌面 Host/Web）和 `127.0.0.1:43129`（本项目插件桥）监听。`curl` 访问两端 `/` 均返回 `401`；Host 的 `/api` 也返回 `401`，`/health` 与 `/rpc` 返回 `404`。端口是本机这次运行的观测值，不是稳定 API 承诺；`43129` 属于本项目，不是 DSH 原生端口。

### 能力矩阵与迁移目标

以下“外部”指 MCP 直接启动受支持的 ACP 子进程，不表示它接管桌面窗口中正在运行的 Web 会话。ACP 会管理自己的持久会话。

| MCP 能力 | 外部 ACP | 说明 |
| --- | --- | --- |
| `dsh_info` 独立读取模型目录、推理档位 | ❓ | ACP 在 `session/new` 返回模型/推理选项；没有只读目录方法。为读取选项先建会话会留下空会话 |
| 新建聊天、选择模型/推理强度 | ✅ | `session/new` 与 `session/set_config_option` |
| 发送任务、读取当前状态和回复 | ✅ | `session/prompt`、`session/update`；桥接可消费实时更新 |
| `queue` 排队 | ✅ | SDK 原生排队；ACP 客户端可按会话串行提交，不依赖 DSH 插件 |
| `steer` 插队 | ❌ | ACP 明确不支持 `mode`；要保留 DSH 原生插队语义，仍需插件 |
| 项目列表、创建、删除 | ❌ | ACP 没有 DSH 项目注册表接口 |
| 聊天列表 | ❓ | `session/list` 可列出 ACP 持久会话；它与桌面 Web profile 的普通/归档列表是否完全对应，需实机验证 |
| 聊天归档 | ❌ | ACP `session/close` 只关闭运行时会话，不等于 DSH 归档 |
| 断开重连后按 `after_seq` 回读旧回复 | ❓ | ACP 恢复会话不回放旧更新；如需此保证，需保留插件历史查询或调整 MCP 结果语义 |

**建议的最小插件保留范围：**如果保留现有 `dsh_info` 的只读语义，需要三类能力留在插件侧：模型目录读取、项目/归档管理、原生插队。若改为从真实新会话读取模型选项并接受它留下空会话，才可把插件缩到后两类。新建/派工、模型设置、排队、聊天列表及当前任务结果可改由 ACP 子进程处理。若还要保留断连后的 `after_seq` 历史回读，再把历史查询单独留在插件侧。当前 v1.1.1 仍由 `dsh-plugin.mjs` 处理全部功能；这里是迁移目标，不代表已经完成 ACP 改造。

### 插件扩展点与版本边界

- 官方[插件教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)和[bundle/profile 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)说明了 profile/bundle 清单、`cordis.patch.yml` 的 `id`/`name`/`inject`/`config` 行、插件 `apply(ctx)` 生命周期，以及 `ctx.on()`/`ctx.effect()` 清理方式。这些是公开描述的插件格式和用法。
- 官方没有承诺某个 Cordis/DSH 插件 API 版本在某个 DSH 版本范围内保持兼容。[开发者预览说明](https://www.deepseek.com/harness/en/)明确说核心插件和 API 会继续演进。
- [插件管理器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)可按插件声明的 `peerDependencies` 检查其支持的 DSH 版本；这是安装/启动时的兼容性门槛，不是 API 不变承诺。绕过检查需要对精确版本显式豁免。
- ACP v1 是当前最清晰的自动化协议边界；它提供标准协议语义，但不让 ACP 客户端控制桌面 Web 会话，也不覆盖 DSH 专属归档和 `steer` 行为。
- `dsh --version` 是可用的版本探测方式。插件 Context 文档没有承诺提供 DSH 版本字段；若要 fail fast，由外部启动器调用版本命令后再启动 ACP 更稳妥。

| 扩展点 | 官方文档说明 | 稳定性结论 |
| --- | --- | --- |
| Bundle/Profile 清单 | `package.json` 中的 `dsh.bundle.patch`、`dsh.profile.bundles`；用于分发与组合插件 | 有公开格式说明，没有跨版本兼容保证 |
| `cordis.patch.yml` | 有序 patch 层；条目以 `id` 定位，支持 `name`、`inject`、`config`；覆盖时整段替换 `config` | 有公开格式与行为说明，没有独立的配置格式版本保证 |
| Cordis 插件入口 | `name`、`apply(ctx)`、可选 `inject`/`Config`；注册项用 `ctx.on`/`ctx.effect` 清理 | 可用插件 API，但没有 DSH 版本范围内保持兼容的承诺 |
| CLI 与 headless | `--profile`、`--patch`、`--version`；headless 一次任务、JSON 事件和会话 ID | 当前文档化用法；DSH developer preview 未承诺长期 CLI 兼容 |
| ACP | DSH 文档声明实现稳定的 ACP v1，并公布会话、模型、推理强度和任务更新接口 | 目前唯一明确标为 stable 的协议边界；桌面产品仍处于 developer preview |

本项目 v1.1.1 仍依赖插件注入的宿主服务，例如会话局部模型选择、项目注册和归档。它能与已验证的桌面版本配合，但不能据此推断其他发行版或未来版本兼容。

Codex 主控使用 Codex 自己的模型与订阅；执行模型使用 DSH 中配置的模型服务。桥接不会把 Plus 订阅转成 API 额度，也不会替你购买执行额度。文件操作、工具和权限仍由 DSH profile 控制。

`dsh_chats` 当前最多返回 20 条，`limit` 最大为 100；`include_archived: true` 查看归档，`bridge_only: true` 仅列出桥接创建的聊天。

## 本地检查

```powershell
node --check server.mjs
node --check dsh-plugin.mjs
node check-mode.mjs
```

`check-mode.mjs` 检查提供方白名单、默认排队、显式排队、插队及无效模式，使用隔离桥接和模拟的 DSH 投递接口，不调用模型 API。它不替代真实 DSH 的端到端检查。

## 版本

| 版本 | 内容 |
| --- | --- |
| `v1.0` | 模型信息、发送任务、读取结果的最小桥接 |
| `v1.1` | 项目管理、聊天列表与归档、每个新聊天独立选择模型和推理强度 |
| `v1.1.1` | 新增 `queue` / `steer` 排队与插队 |

`connection-check.json` 是经过路径和提供方脱敏的 v1.0 历史连接样例。本机配置、密钥、依赖安装目录和原配置备份不应上传。

## 移除

执行 `codex mcp remove dsh`，删除实际 Profile 中 `BEGIN CODEX DSH MCP` 到 `END CODEX DSH MCP` 之间的桥接条目，再重启 DSH。仅删除桥接条目，保留其他插件配置。

## Contributors

- [Guo Chengran (@guochengran464-byte)](https://github.com/guochengran464-byte) — project creator and maintainer
- ChatGPT — AI-assisted architecture, coding, review, and documentation

## 许可证

本项目采用 [MIT License](LICENSE)。

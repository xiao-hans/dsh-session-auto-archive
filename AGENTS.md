# AGENTS.md — dsh-session-auto-archive · DSH 会话归档插件工程宪法

> 仓库级协作入口：在本仓库开始编码、排查、评审或文档工作前先通读本文件。

## 1. 项目定位与背景

- **目标**：为 DeepSeek Harness（DSH）桌面端提供闲置会话自动归档、归档历史、单条/批量撤销；撤销必须恢复可继续对话的原会话，而不是只让空壳回到侧栏。
- **仓库形态**：单仓库 Git 工程，作为 profile 的 `file:` 插件安装；宿主运行时实际加载 `~/.dsh/profiles/desktop/node_modules/dsh-session-auto-archive` 副本，源码工作树的变更需同步到该副本并完全重启 DSH 才生效。
- **权威依据**（按优先级）：
  - `package.json` — 包入口、`exports`、DSH manifest、运行时依赖与测试命令。
  - `lib/index.js` — 宿主侧定时器、扫描、归档、审计与 HTTP API。
  - `lib/session-restore.mjs` — 撤销/恢复、批次记录与可见性修复。
  - `lib/client.js` — 浏览器侧设置卡片、归档历史与交互。
  - `test/revert.test.mjs`、`npm test` — 回归验证基线。
  - `README.md` — 用户可见行为、默认配置与限制；行为变更后必须同步。
  - `cordis.patch.yml` — 插件树装配入口。

## 2. 硬性边界与红线

1. **resume 完整性红线**：归档/撤销不得丢失 `session.v4.jsonl.zstd` 中的历史事件。禁止用 header-only stub、空标题或空白 projcache 冒充「已恢复会话」；若无完整日志与投影备份，撤销必须明确失败或返回不可恢复警告，不得把 id 放回工作区后让用户点进空白会话。
2. **数据保护红线**：归档前先备份原会话日志与对应 projcache；还原时使用 `wx`/备份校验，绝不覆盖更大的现有日志或更新的用户数据。任何删除、覆盖、写真实 storage 的操作先读取目标、保留备份并说明影响。
3. **宿主契约红线**：`workspaceRegistry.archiveSession()` / `unarchiveSession()` 只改变归档标志；`WorkspaceEntity.mutate()` 会剪掉无 header 的 `sessionIds`，恢复成员关系必须用 `attachSession()` 且 stub/备份日志的 `cwd` 与 `record.path` canonical 一致。不得伪造 `api-session/added` 来掩盖缺失的历史事件。
4. **工程边界**：仅修改本仓库文件；同步 node_modules 副本属于部署动作，需逐文件校验且不得用 `pnpm install` 静默替代。当前改动未获授权不提交 git、不重启宿主、不向外部服务发布数据。
5. **兼容边界**：依赖 DSH 内部服务名与 slot 名（`sessionPersistence`、`workspaceRegistry`、`webServer`、`settings.section`、`plugin-settings.item`）；跨大版本先核对宿主 `app.asar` 再适配。

## 3. 技术栈与模块拓扑

- **运行与工具链基线**：Node.js（ESM，`package.json` 的 `type: module`）、Cordis 插件树、DSH 宿主进程 + 浏览器客户端；`npm test` 为 `node --test test/*.test.mjs`，无打包步骤；zstd 帧由 Node `node:zlib` 读写。

| 模块 / 子系统 | 路径或产物 | 职责归属与依赖方向约束 |
| --- | --- | --- |
| 宿主插件入口 | `lib/index.js` | 定时器、`ctx.sessionPersistence.list()` 扫描、`archiveSession()`、审计、loopback HTTP 路由；可调用 `lib/session-restore.mjs`，不得反向依赖浏览器客户端。 |
| 会话恢复 | `lib/session-restore.mjs` | 备份/还原日志与投影、恢复工作区槽位、批次持久化；只依赖 Node 标准库与宿主 ctx，禁止写 UI 状态。 |
| Web 客户端 | `lib/client.js` | `window.__ModuleLoader__.load` 工厂、设置卡片、历史三态渲染；只通过 `/api/dsh-auto-archive/*` 与宿主通信。 |
| 插件装配 | `cordis.patch.yml`、`package.json` 的 `dsh` 字段 | 插入 profile 插件树并声明 client inject；不得写死本机绝对路径。 |
| 回归测试 | `test/revert.test.mjs` | 覆盖路径编码、日志帧、完整 resume、幂等、批次跨重启、缺数据降级、卡片首屏渲染。 |
| 安装/更新脚本 | `scripts/update.mjs` | 注册依赖、检查更新；`file:` 安装副本需另行同步，脚本不会自动刷新。 |

- **关键技术取舍**：采用「归档时备份原始日志与 projcache、撤销时原子还原」替代「projcache 重建 header-only stub」：后者只能恢复侧栏可见性，无法恢复对话内容，已由实机验证证伪。

## 4. 目录结构

```text
dsh-session-auto-archive/
├─ AGENTS.md                 仓库协作约定
├─ CLAUDE.md                 @AGENTS.md（Claude Code 仓库适用）
├─ README.md                 用户说明、默认配置、撤销流程与限制
├─ package.json              包入口、DSH manifest、npm test
├─ cordis.patch.yml          插件树 insert
├─ lib/
│  ├─ index.js               宿主侧扫描/归档/审计/HTTP API
│  ├─ session-restore.mjs    完整日志备份/还原、批次与工作区恢复
│  └─ client.js              设置卡片与归档历史
├─ scripts/update.mjs        注册与更新脚本
└─ test/revert.test.mjs      node:test 回归用例
```

## 5. 公开契约 / 接口 / 协议

- **loopback HTTP API**（权威实现 `lib/index.js`）：`GET /api/dsh-auto-archive/status`、`GET|POST /api/dsh-auto-archive/settings`、`POST /api/dsh-auto-archive/run`、`POST /api/dsh-auto-archive/revert`、`GET /api/dsh-auto-archive/history?limit=N`。
- **持久化契约**：`~/.dsh/storages/auto-archive/{config.json,status.json,audit.log,last-archive.json}`；会话日志位于 `~/.dsh/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd`，投影位于 `~/.dsh/storages/session_projcache/sessions/<sessionId>.json`，工作区成员关系位于 `~/.dsh/storages/workspace.json`。
- **变更规则**：新增或修改对外行为前核对 `README.md` 的 API/限制表；撤销响应必须区分 `reverted` / `restored` / `skipped` / `warnings` / `details`，并在无法完整恢复时显式报错。

## 6. 数据模型与状态持久化

- **日志格式**：每行一个 zstd 帧或可解压的单帧多行 JSONL；首行是 `type:"session"` header（`HEADER_KEYS` 白名单），后续 `user/assistant/tool/turn/...` 事件才是 resume 所需内容。
- **核心不变量**：同一 `sessionId` 的完整日志必须先于 `unarchiveSession()` 备份成功；备份记录含 `sha256`、字节数、`cwd`、projcache 快照；还原后 header.id 必须与目标 id 一致，且不得出现 `blank:true` 的空白投影。
- **兼容策略**：`last-archive.json` 缺失时从 `audit.log` 尾部按 5 分钟窗口重建批次；旧版已解归档但不可见的 id 只有在存在完整备份时才能补救，否则只写诊断警告。

## 7. Skill 调度

- **动态匹配与全文读取**：任务开始、需求变更或进入新阶段时匹配当前会话 Skill；执行前读取 `SKILL.md` 全文及要求的参考文件。Skill 不授予安装依赖、修改全局配置、提交/推送或写外部状态的权限。
- **发现记录**：当前会话技能清单与 `C:\Users\HANXIAO\.claude\skills\project-agents-md\SKILL.md` 已确认 `project-agents-md` 存在；全局规则来自用户级 `CLAUDE.md`/`RTK.md`/`AGENTS.md`，RTK 会压缩命令输出。

| 触发场景 | 调用的 Skill | 用途与产出要求 |
| --- | --- | --- |
| 新仓库/工程约定漂移、需生成或更新 `AGENTS.md` / `CLAUDE.md` | `project-agents-md` | 以仓库证据生成工程宪法、Skill/MCP 调度表；`CLAUDE.md` 仅保留 `@AGENTS.md`。 |

## 8. MCP 与工具调度

- **调用与降级准则**：① 调用前用 `ToolSearch` 核实当前会话工具名与参数；② 写文件/改外部状态前读取目标；③ 不向外部服务发送密钥或凭证；④ MCP 结果与仓库源码冲突时以实读源码为准；⑤ 工具不可用时降级到 `Read`/`Grep`/`Bash`/`PowerShell`/`Write`/`Edit`，并在交付时说明。

| 触发场景 | 调用的 MCP / 工具 | 用途与降级方式 |
| --- | --- | --- |
| 大段源码/日志按意图抽取 | `mcp__context-mode__ctx_execute` + `mcp__plugin_context-mode_context-mode__ctx_search` | 在沙箱打印或索引大输出；不可用时用 `Grep` + 分段 `Read`，长输出每次控制在 40 行内。 |
| 代码库符号/调用链理解（仅当仓库存在 `.codegraph/`） | `mcp__codegraph__codegraph_explore` | 优先取符号源码与调用路径；无索引或工具不可用时用 `Grep` + `Read`。 |
| 已确认的疑难根因/环境事实需跨会话保留 | `mcp__basic-memory__bm_search` / `bm_write` / `bm_edit` | 遵守 `rules/memory-consolidation-policy.md`；不可用时只在当前会话说明，不伪称已写入。 |
| 压缩已消费的长会话上下文 | `mcp__bili__compress` / `search_context` / `decompress` | 保留路径、结论与开放目标；不可用时继续用内置摘要。 |
| Windows 文件/进程/宿主 app.asar 检查 | `PowerShell` 或内置文件工具 | 读取 `D:/DSH Desktop/resources/app.asar` 用绝对盘符路径；不可用 `MSYS /d/...` 形式。 |

- **发现记录**：以上 MCP 名称来自当前会话工具列表与 `ToolSearch`；仓库内未发现项目级 MCP 配置文件，不得假定新环境自动具备这些扩展。

## 9. 验证、提交与完成标准

- **日常验证**：改动后运行 `npm test`、`node --check lib/index.js && node --check lib/session-restore.mjs && node --check lib/client.js`；对完整恢复新增用例必须用临时目录构造含真实对话事件的 zstd 日志，断言还原后逐行一致、标题/blank/lastPromptAt 恢复、工作区可见且可 resume。静态检查通过不等于实机 resume 成功。
- **部署验证**：同步 source → installed 副本后逐文件 SHA256 比对；只有用户完全退出 `DeepSeek Harness` 进程并重启，才能在归档历史点 archived 行验证会话内容确实可继续，不得由 Agent 主动重启宿主。
- **工作区保护**：运行 `git diff --check` 与 `git status --short`，保留无关未提交改动；排查临时文件不纳入版本库，交付前清理 `test/_*`。
- **提交与推送**：仅在用户明确要求时提交，提交说明写明变更原因与影响范围；不自动 push。
- **Definition of Done**：
  - [ ] 归档时备份完整日志 + projcache，撤销时恢复原始事件而非空壳；缺备份时明确失败且不污染工作区。
  - [ ] `npm test` 与三份 lib 的 `node --check` 通过，新增 resume 回归用例可复现。
  - [ ] `README.md`、`AGENTS.md` 与实际行为一致；source/installed 文件一致；实机验证点开恢复后的会话能看到原对话。

## 10. 待确认清单

- [ ] 2026-11-15 实机目标 `session-e578b1ea-f433-4368-8950-ef117e21c6f7` 的原始完整日志是否已从回收站/卷影/备份中找回 — 需用户确认是否有外部备份或允许进一步做磁盘恢复。

# dsh-session-auto-archive

DeepSeek Harness（DSH）插件：按**闲置天数自动归档会话**。DSH 原生只有手动的 Archive 按钮，本插件补上自动触发器：定时扫描全部会话，把长期不活跃的会话归档掉，侧栏立刻清爽；误归档可随时单条撤销。

- 设置卡片直接挂在 **设置 → 插件设置**（与 dsh-qoder-connect 同一共享区块），也出现在 **侧栏 插件 → 已安装 → 本插件行 → 配置**。
- 卡片为折叠式单行（点击展开），版式对齐 DSH 主题令牌，自动跟随深/浅色主题。
- 内置**归档历史**：审计日志尾部（含会话标题、闲置天数、cwd），已归档条目可**逐条撤销**。

## 功能与默认值

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `idleDays` | `14` | 闲置多少天算“该归档”（以最后活动时间计） |
| `dryRun` | `true` | 演练模式：只写审计、不真正归档。**首次安装务必先跑一轮演练** |
| `keepPinned` | `true` | 置顶会话永不自动归档 |
| `includeSubagents` | `false` | 子代理会话是否参与归档 |
| `intervalHours` | `12` | 定时扫描节奏 |
| `startupDelayMs` | `60000` | 启动后延迟多久跑第一轮 |
| `excludeCwdSubstrings` | `[]` | cwd 命中任一子串的会话跳过 |

判定“闲置”的活动信号取三者最大值：会话日志文件 mtime（从 snapshot revision 解析）、projcache `lastPromptAt`、`createdAt`。注意 projcache 文件**自身的** mtime 会被后台元数据维护重写，不能当信号用。

安全底线：live（当前打开/在跑）、置顶、工作区活动非空、命中排除清单的会话一律跳过；归档走 DSH 原生 `workspaceRegistry.archiveSession()`，与手动归档完全同一状态（workspace.json 的 `global.archivedSessionIds`），不删任何数据。

## 安装

把本仓库放进 DSH profile 目录并注册为 bundle（以 `desktop` profile 为例，目录 `~/.dsh/profiles/desktop`）：

1. 克隆到 profile 下：
   ```bash
   cd ~/.dsh/profiles/desktop
   git clone https://github.com/xiao-hans/dsh-session-auto-archive.git
   ```
2. 在 `package.json` 的 `dependencies` 加：
   ```json
   "dsh-session-auto-archive": "file:./dsh-session-auto-archive"
   ```
   并把包名追加进 `dsh.profile.bundles` 数组。
3. 在该 profile 目录执行 `pnpm install`。
4. 重启 DSH。插件自带的 `cordis.patch.yml` 会把 `session-auto-archive` 插入插件树，无需额外 patch。

也可以打成 npm 包安装（仓库名即包名）。

## 使用

- 安装后打开 **设置 → 插件设置 → 会话自动归档** 展开卡片。
- 建议流程：先保持 `dryRun` 开 → 点“立即扫描” → 到“归档历史”里看 `planned` 条目是否都是你想归档的 → 关闭 `dryRun` 正式启用。
- 撤销：历史里单条“撤销”（走原生 unarchive），或点“撤销上次批量”。
- 数据落盘在 `~/.dsh/storages/auto-archive/`：`config.json`（插件自持配置，Web UI 读写）、`status.json`（上次运行）、`audit.log`（JSONL 审计流水）。

## HTTP API（仅 loopback）

| 路由 | 说明 |
| --- | --- |
| `GET /api/dsh-auto-archive/status` | 当前配置 + 上次运行结果 |
| `GET/POST /api/dsh-auto-archive/settings` | 读/写配置（POST 带 `expectedRevision` 防冲突，冲突返回 409） |
| `POST /api/dsh-auto-archive/run` | 手动触发一轮扫描，body 可带 `{ dryRun }` |
| `POST /api/dsh-auto-archive/revert` | 撤销上次批量；body 带 `{ sessionId }` 则单条撤销 |
| `GET /api/dsh-auto-archive/history?limit=N` | 审计历史（新→旧），条目已补会话标题 |

## 开发说明

- `lib/index.js`：宿主侧（timer、扫描、归档、审计、路由）。
- `lib/client.js`：浏览器侧（React 卡片，`window.__ModuleLoader__.load` 工厂；经 `settings.section`/`plugin-settings.item` 共享区块与 `plugins.row.config` 两个槽位挂载）。
- 本地联调时直接改 profile 目录内的源文件：客户端改动刷新页面即生效（combo rev 随文件元数据变化）；宿主侧改动需禁用→启用插件一次以重新注册路由。

## 限制

- 依赖 DSH 内部服务名（`sessionPersistence`、`workspaceRegistry`、`webServer`、槽位 `plugin-settings.item`），跨大版本可能需要适配；实测基线 0.2.1-rc.2。
- 语言：卡片内建中/英双语文案（按浏览器语言选择）。

## License

MIT

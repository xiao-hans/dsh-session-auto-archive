# dsh-session-auto-archive

DeepSeek Harness（DSH）插件：按**闲置天数自动归档会话**。DSH 原生只有手动的 Archive 按钮，本插件补上自动触发器：定时扫描全部会话，把长期不活跃的会话归档掉，侧栏立刻清爽；误归档可随时单条撤销。

- 设置卡片直接挂在 **设置 → 插件设置**（与 dsh-qoder-connect 同一共享区块），也出现在 **侧栏 插件 → 已安装 → 本插件行 → 配置**。
- 卡片为折叠式单行（点击展开），版式对齐 DSH 主题令牌，自动跟随深/浅色主题。
- 内置**归档历史**：审计日志尾部（含会话标题、闲置天数、cwd），已归档条目可**逐条撤销**。
- 附带两个**侧栏排序**辅助能力：`回到会话自动取消归档`（会话再次产生用户消息时自动 unarchive，于是它带着新鲜的活跃时间回到列表顶部），以及手动排序模式的一次性诊断/修复（详见「侧栏排序」）。

## 功能与默认值

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `idleDays` | `14` | 闲置多少天算“该归档”（以最后活动时间计） |
| `dryRun` | `true` | 演练模式：只写审计、不真正归档。**首次安装务必先跑一轮演练** |
| `keepPinned` | `true` | 置顶会话永不自动归档 |
| `includeSubagents` | `false` | 子代理会话是否参与归档 |
| `autoUnarchive` | `true` | 会话再次产生用户消息时自动取消归档（配合「按最近活跃」排序回到顶部） |
| `intervalHours` | `12` | 定时扫描节奏 |
| `startupDelayMs` | `60000` | 启动后延迟多久跑第一轮 |
| `excludeCwdSubstrings` | `[]` | cwd 命中任一子串的会话跳过 |

判定「闲置」的活动信号：优先取 projcache 里的用户活动戳（`sessionListMetadata.lastPromptAt` 与 `timeContext.lastMessageTime` 取较大者，与侧栏「N 天」同源）。会话日志文件 mtime 只在该戳缺失、或两者相差不到 24 小时（`STALE_LOG_MTIME_MS`）时才采信。注意 projcache 文件**自身的** mtime 也不能当信号用——DSH 会往会话日志追加 `permission/preset`、`sandbox/mode`、`approval/policy`、`session/end-seed` 这类纯元数据记录并重写文件时间戳，实测一次批量重写 touch 了 10 个会话文件，把闲置 10 天的会话刷成「3 天前刚活动」；无条件采信文件 mtime 就会漏归档。

安全底线：live（当前打开/在跑）、置顶、工作区活动非空、命中排除清单的会话一律跳过；归档走 DSH 原生 `workspaceRegistry.archiveSession()`，与手动归档完全同一状态（workspace.json 的 `global.archivedSessionIds`），不删任何数据。

## 侧栏排序

DSH 侧栏有两种排序模式（**视图**菜单里切换）：`按最近活跃` 严格按最后一次用户消息时间倒序；`手动` 则优先使用拖拽保存下来的位置——手动模式下你回到某个老会话继续聊，它的时间标签会刷新，但**不会**排到最上面，归档过的条目还会被钉在列表底部。本插件不替换原生比较器（排序状态是浏览器本地的 view store，官方没给插件留改比较器的口子），而是做两件可达成的事：

1. **回到会话自动取消归档**（`autoUnarchive`）：监听宿主 `api-session/activity` 事件——只有用户亲手发出的持久消息才会触发。归档中的会话在 UI 里根本打不开，所以这个事件对已归档 id 只可能来自定时任务/目标续跑这类后台轮次；插件此时立刻 `unarchiveSession()` 并写一条 `by:"reactivated"` 审计。这条消息本身已经把 `updatedAt` 刷新，于是会话在「按最近活跃」模式下直接回到顶部。
2. **排序模式诊断**：卡片展开时读出浏览器本地 `dsh.workspace.view.v5` 里的 `orderBy`。若为 `手动`，卡片显示一行说明并提供「切回按最近活跃」按钮——点击写入 `{orderBy:"updated", sessionOrderByAccount:{}}`（与原生菜单行为一致：离开手动模式会清空保存的拖拽顺序）并立刻刷新页面，因为该 view store 只在启动时 hydrate 一次。只读诊断不写盘；除非你点那个按钮。

> 想让「回到老会话后它冒到最上面」成立，需要同时满足：排序模式为 `按最近活跃`（卡片第一行可确认/一键修正）+ 该会话没有被归档（`autoUnarchive` 负责）。

> 修复按钮写完后会立刻刷新页面（view store 只在启动时加载一次）。刷新时偶发出现一次「启动失败 / entry did not activate」错误页：那是整张插件 combo bundle 在重载瞬间的导入竞态，**与刚写入的排序数据无关**——点「重试」即可，写入早已落盘。v0.1.5 起本插件改为按需加载（与其他社区插件一致），进一步降低这种竞态。

## 安装

### 方式 A：npm 包（推荐）

DSH 的 profile 是 pnpm 工程（`nodeLinker: hoisted` + `pnpm-lock.yaml`），所以用 pnpm 装，别用 `npm install` 混装：

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-session-auto-archive           # 国内镜像源滞后时用：--registry=https://registry.npmjs.org/
node node_modules/dsh-session-auto-archive/scripts/update.mjs --register
```

重启 DSH。插件自带的 `cordis.patch.yml` 会把 `session-auto-archive` 插入插件树，无需额外 patch。

### 方式 B：git 克隆（便于跟仓库改动）

1. 克隆到 profile 下：
   ```bash
   cd ~/.dsh/profiles/desktop
   git clone https://github.com/xiao-hans/dsh-session-auto-archive.git
   ```
2. 注册进 profile（写 `package.json` 的 `dependencies` 与 `dsh.profile.bundles`，幂等；也可以按老办法手工改这两个字段）：
   ```bash
   node dsh-session-auto-archive/scripts/update.mjs --register
   ```
3. 在该 profile 目录执行 `pnpm install`。
4. 重启 DSH。

> 两种方式都要在 profile 的 `dsh.profile.bundles` 里出现 `dsh-session-auto-archive`；`--register` 就是替你写这个，幂等，重复跑安全。

## 更新（多机）

插件就放在 profile 目录下的 git 克隆里，更新 = pull + 按需 install + 重启。仓库自带 `scripts/update.mjs`（零依赖，Windows/macOS/Linux 通用）：

```bash
# 首次安装（第 2 步的替代）：自动写 profile 的 dependencies 与 dsh.profile.bundles，幂等
node dsh-session-auto-archive/scripts/update.mjs --register

# 看有没有新版本（不动盘；有新版时退出码 10，方便脚本化）
node dsh-session-auto-archive/scripts/update.mjs --check

# 更新：git pull --ff-only；依赖有变化自动在 profile 目录 pnpm install
node dsh-session-auto-archive/scripts/update.mjs
```

脚本会拒绝在有未提交改动的树上 pull（防止覆盖本地补丁）；装成 npm 包时没有 .git，按提示重装新版本包即可。更新后必须完全重启 DSH（或禁用→启用本插件），并用 `GET /api/dsh-auto-archive/status` 返回里的 `version` 或设置卡片标题右侧的版本徽章自证生效。


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

/**
 * dsh-session-auto-archive — 按闲置时长自动归档 DSH 会话的本地插件。
 *
 * 原理：DSH 原生已有归档（workspace.json 的 global.archivedSessionIds，GUI Archive
 * 按钮走 workspace/archiveSession），但没有自动触发器。本插件在宿主进程内用定时器
 * 周期性扫描 ctx.sessionPersistence.list()。闲置时间以 projcache 里的用户活动戳
 * （lastPromptAt / timeContext.lastMessageTime，与侧栏「N 天」同源）为准；会话日志
 * 文件 mtime（从 snapshot.revision 解析）只在该戳缺失、或与活动戳相差不到
 * STALE_LOG_MTIME_MS 时采信 —— 否则视为被元数据重写污染。注意 projcache 文件**自身**
 * 的 mtime 也不可用（同样会被后台重写，实测藏掉过 18 天闲置的会话）。超过 idleDays 的
 * 调用 ctx.workspaceRegistry.archiveSession(sessionId)（不带 stopActivity —— 带了
 * 会连带删除该会话的定时任务，且活动会话会被 WorkspaceActiveSessionError 拒绝）。
 *
 * 安全默认：dryRun 开启时只写审计报告不动状态；pinned 会话跳过；live（当前打开/在
 * 跑）会话跳过；workspace/session-activity waterfall 非空的会话跳过；可用
 * excludeCwdSubstrings 排除整个工作区。
 *
 * 手动触发：POST /api/dsh-auto-archive/run（loopback-only），body 可带 { dryRun }。
 * 状态与审计：~/.dsh/storages/auto-archive/{status.json,audit.log}。
 */
import z from '@deepseek-ai/schemastery';
import { getService, dshHome, plainConfig, isLoopbackRequest, writeJson } from '@hyzyn/dsh-kit';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const Config = z.object({
    /** 总开关。false 时插件不扫描、不归档。 */
    enabled: z.boolean().default(true).volatile(),
    /** 闲置多少天算“该归档”。以最后一次 prompt（或可得的最近活动时间）为准。 */
    idleDays: z.number().min(0.5).default(14).volatile(),
    /** 只演练不真正归档：审计里记录 willArchive。首次启用建议先跑一轮。 */
    dryRun: z.boolean().default(true).volatile(),
    /** 置顶会话永不自动归档。 */
    keepPinned: z.boolean().default(true).volatile(),
    /** 子代理会话（delegationDepth>0 / origin=subagent）是否也参与自动归档。 */
    includeSubagents: z.boolean().default(false).volatile(),
    /** 已归档会话再次收到用户消息（定时任务/目标续跑等）时自动取消归档。 */
    autoUnarchive: z.boolean().default(true).volatile(),
    /** 扫描节奏（小时）。 */
    intervalHours: z.number().min(0.25).default(12).volatile(),
    /** 启动后延迟多久跑第一轮（毫秒），避开冷启动高峰。 */
    startupDelayMs: z.number().default(60_000).volatile(),
    /** cwd 命中任一子串（大小写不敏感）的会话直接跳过。 */
    excludeCwdSubstrings: z.array(z.string()).default([]).volatile(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** 日志文件 mtime 比用户活动戳新出这么多即视为「元数据重写污染」，不再采信。
 *  正常会话该差值 ≤ 约 2 小时；实测污染场景为 3.4~7 天。 */
const STALE_LOG_MTIME_MS = 24 * 60 * 60 * 1000;


/** 包版本：从 package.json 单点读取，供日志与 /status 自证「本机跑的是哪个版本」。
 *  多机部署时靠它确认 git pull / npm 更新真的生效了，不必去比对文件内容。 */
const PKG_VERSION = (() => {
    try {
        return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))?.version ?? 'unknown';
    } catch {
        return 'unknown';
    }
})();
const LOG_PREFIX = '[dsh-session-auto-archive]';

function definePluginLocal(plugin) { return plugin; }

/** 读一个会话的用户活动戳（projcache）：lastPromptAt（最后一次 prompt）、
 *  lastMessageTime（timeContext 里最后一条消息时间，含注入，通常与前者同毫秒）
 *  与 createdAt，读不到返回 undefined。
 *  注意：projcache 文件的 mtime 会被后台元数据维护重写（实测有会话闲置 18.7 天
 *  但文件 0.7 天前刚被 touch），**不能**当活动信号用。 */
async function readProjcacheSignal(sessionsDir, sessionId) {
    const candidates = [sessionId, sessionId.replace(/^session-/, '')];
    for (const name of candidates) {
        const file = join(sessionsDir, `${name}.json`);
        if (!existsSync(file)) continue;
        try {
            let lastPromptAt;
            let lastMessageTime;
            let createdAt;
            try {
                const raw = JSON.parse(await readFile(file, 'utf8'));
                lastPromptAt = raw?.record?.rows?.sessionListMetadata?.val?.lastPromptAt;
                lastMessageTime = raw?.record?.rows?.timeContext?.val?.lastMessageTime;
                createdAt = raw?.record?.identity?.createdAt;
            } catch { /* 坏文件：只用其它信号 */ }
            const num = (v) => (typeof v === 'number' && v > 0 ? v : undefined);
            return { lastPromptAt: num(lastPromptAt), lastMessageTime: num(lastMessageTime), createdAt: num(createdAt) };
        } catch { /* ignore */ }
    }
    return undefined;
}

/** sessionPersistence 的 revision 串 = "dev:ino:size:mtimeNs:ctimeNs"
 *  （dsh-session-persistence-jsonl fileRevision，SessionPersistenceRevision 是恒等函数）。
 *  取会话日志文件自身的 mtime —— 仅作用户活动戳缺失时的兜底，见使用处。 */
function logMtimeFromRevision(revision) {
    if (typeof revision !== 'string') return undefined;
    const parts = revision.split(':');
    if (parts.length < 5) return undefined;
    const ns = Number(parts[3]);
    if (!Number.isFinite(ns) || ns <= 0) return undefined;
    const ms = Math.floor(ns / 1e6);
    return ms > 0 && ms < Date.now() + 60_000 ? ms : undefined;
}

function makeRunner(ctx, resolveConfig) {
    const home = dshHome();
    const storeDir = join(home, 'storages', 'auto-archive');
    const projcacheDir = join(home, 'storages', 'session_projcache', 'sessions');
    let running = false;
    let lastResult = undefined;
    let lastArchivedRun = undefined; // { at, sessionIds[] } 供一键撤销

    // 撤销：把本插件最近一次真实归档的会话 unarchive 回来（不带 stopActivity，纯移出 archivedSessionIds）。
    async function revertLast(sessionId) {
        const registry = getService(ctx, 'workspaceRegistry');
        if (!registry || typeof registry.unarchiveSession !== 'function') {
            throw new Error('workspaceRegistry.unarchiveSession not available on ctx');
        }
        const ids = sessionId ? [String(sessionId)] : (lastArchivedRun?.sessionIds ?? []);
        const archived = new Set(registry.archivedSessionIds ?? []);
        const reverted = [];
        for (const id of ids) {
            if (!archived.has(id)) continue;
            await registry.unarchiveSession(id);
            reverted.push(id);
            await audit({ at: new Date().toISOString(), sessionId: id, action: 'unarchived', by: 'revert' });
        }
        return { reverted, at: lastArchivedRun?.at };
    }

    const audit = async (line) => {
        try {
            await mkdir(storeDir, { recursive: true });
            await appendFile(join(storeDir, 'audit.log'), `${JSON.stringify(line)}\n`, 'utf8');
        } catch (error) {
            ctx.logger?.warn?.(`${LOG_PREFIX} audit write failed: ${error?.stack ?? error}`);
        }
    };

    async function runOnce(trigger, overrides) {
        const ov = overrides && typeof overrides === 'object' ? overrides : {};
        const config = {
            ...resolveConfig(),
            ...(typeof ov.dryRun === 'boolean' ? { dryRun: ov.dryRun } : null),
            ...(Number.isFinite(ov.idleDays) && ov.idleDays > 0 ? { idleDays: ov.idleDays } : null),
            ...(ov.allowLive === true ? { allowLive: true } : null),
            ...(typeof ov.onlySessionId === 'string' && ov.onlySessionId ? { onlySessionId: ov.onlySessionId } : null),
        };
        if (!config.enabled && !ov.allowDisabled) return { ok: false, skipped: 'disabled' };
        if (running) return { ok: false, skipped: 'already-running' };
        running = true;
        const startedAt = Date.now();
        const newlyArchived = [];
        const result = { ok: true, trigger, at: new Date(startedAt).toISOString(), dryRun: config.dryRun, idleDays: config.idleDays, scanned: 0, archived: 0, planned: 0, skippedByReason: {}, errors: [] };
        try {
            const registry = getService(ctx, 'workspaceRegistry');
            if (!registry || typeof registry.archiveSession !== 'function') {
                throw new Error('workspaceRegistry service not available on ctx');
            }
            const persistence = getService(ctx, 'sessionPersistence');
            if (!persistence || typeof persistence.list !== 'function') {
                throw new Error('sessionPersistence service not available on ctx');
            }
            const archived = new Set(registry.archivedSessionIds ?? []);
            const pinned = new Set(registry.pinnedSessionIds ?? []);
            const sessionsService = ctx.get?.('sessions') ?? ctx.sessions;
            const snapshots = await persistence.list();
            const cutoff = Date.now() - config.idleDays * DAY_MS;
            const excludes = (config.excludeCwdSubstrings ?? []).map((s) => String(s).toLowerCase()).filter(Boolean);

            for (const snapshot of snapshots) {
                const header = snapshot?.header;
                const id = header?.id;
                if (!id || typeof id !== 'string') continue;
                if (config.onlySessionId && id !== config.onlySessionId) continue;
                result.scanned += 1;
                const skip = (reason) => {
                    result.skippedByReason[reason] = (result.skippedByReason[reason] ?? 0) + 1;
                    const samples = (result.skippedSamples ??= {});
                    const arr = (samples[reason] ??= []);
                    if (arr.length < 10) arr.push(id);
                };

                if (archived.has(id)) { skip('already-archived'); continue; }
                if (config.keepPinned && pinned.has(id)) { skip('pinned'); continue; }
                if (!config.includeSubagents && ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent')) { skip('subagent'); continue; }
                const cwd = typeof header.cwd === 'string' ? header.cwd.toLowerCase() : '';
                if (excludes.length && excludes.some((needle) => cwd.includes(needle))) { skip('excluded-cwd'); continue; }
                // 当前仍在宿主里的会话（含本会话、正在跑的）默认绝不归档。
                // allowLive 仅供调试：跳过 live 判定（activity waterfall 仍会拦在跑的）。
                try {
                    if (!config.allowLive && sessionsService?.get?.(id) !== undefined) { skip('live'); continue; }
                } catch { /* ignore */ }

                const signal = await readProjcacheSignal(projcacheDir, id);
                const logMtime = logMtimeFromRevision(snapshot.revision);
                // 主信号 = projcache 用户活动戳（lastPromptAt / timeContext.lastMessageTime，
                // 与侧栏「N 天」同源）。日志文件 mtime 只在与该戳相差不到 STALE_LOG_MTIME_MS
                // 时才采信：DSH 会把 permission/preset、sandbox/mode、approval/policy、
                // session/end-seed 这类纯元数据记录追加进会话日志，顺带把文件 mtime 推后
                // （实测 2026-10-24 一次批量重写 touch 了 10 个会话文件），把闲置 10 天的
                // 会话刷成「3 天前刚活动」；无条件 max() 采信 logMtime 就会漏归档。
                // 实测正常会话的 logMtime - 活动戳 ≤ 约 2 小时（回合后台收尾/压缩），
                // 污染场景是 3.4~7 天，24h 这条线分得开。
                // 活动戳完全缺失时退回 logMtime/createdAt，避免把「建了很久但从没动过」
                // 误判成活跃。
                const projstamp = Math.max(signal?.lastPromptAt ?? 0, signal?.lastMessageTime ?? 0);
                const trustLogMtime = !!logMtime && (!projstamp || logMtime - projstamp <= STALE_LOG_MTIME_MS);
                const lastActivity = projstamp > 0
                    ? Math.max(projstamp, trustLogMtime ? logMtime : 0)
                    : Math.max(logMtime ?? 0, signal?.createdAt ?? header.createdAt ?? 0);
                if (!Number.isFinite(lastActivity) || lastActivity <= 0) { skip('no-activity-signal'); continue; }
                if (lastActivity > cutoff) { skip('not-idle'); continue; }

                // schedule 等活跃源（armed 定时任务/在跑轮次）→ 跳过，绝不用
                // stopActivity:true（那会删除该会话的 schedule 行）。
                let activity = [];
                try {
                    activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => []);
                } catch (error) {
                    result.errors.push({ sessionId: id, stage: 'activity-check', message: String(error?.message ?? error) });
                    continue;
                }
                if (Array.isArray(activity) && activity.length > 0) { skip('active'); continue; }

                const entry = {
                    at: new Date().toISOString(), sessionId: id,
                    dryRun: config.dryRun, lastActivity: new Date(lastActivity).toISOString(),
                    idleDays: +((Date.now() - lastActivity) / DAY_MS).toFixed(1), cwd: header.cwd,
                };
                if (config.dryRun) {
                    result.planned += 1;
                    await audit({ action: 'planned', ...entry });
                    continue;
                }
                try {
                    await registry.archiveSession(id);
                    archived.add(id);
                    result.archived += 1;
                    newlyArchived.push(id);
                    await audit({ action: 'archived', ...entry });
                } catch (error) {
                    // WorkspaceActiveSessionError 等：记录并继续。
                    result.errors.push({ sessionId: id, stage: 'archive', message: String(error?.message ?? error) });
                    await audit({ action: 'failed', ...entry, error: String(error?.message ?? error) });
                }
            }
            result.durationMs = Date.now() - startedAt;
            result.newlyArchived = newlyArchived;
            lastResult = result;
            if (!config.dryRun && newlyArchived.length) lastArchivedRun = { at: result.at, sessionIds: newlyArchived.slice() };
            try {
                await mkdir(storeDir, { recursive: true });
                await writeFile(join(storeDir, 'status.json'), JSON.stringify(result, null, 2), 'utf8');
            } catch (error) {
                ctx.logger?.warn?.(`${LOG_PREFIX} status write failed: ${error?.message ?? error}`);
            }
            ctx.logger?.info?.(`${LOG_PREFIX} ${trigger} run: scanned=${result.scanned} planned=${result.planned} archived=${result.archived} dryRun=${config.dryRun} errors=${result.errors.length}`);
            return result;
        } catch (error) {
            const failure = { ...result, ok: false, error: String(error?.message ?? error), durationMs: Date.now() - startedAt };
            lastResult = failure;
            ctx.logger?.warn?.(`${LOG_PREFIX} ${trigger} run failed: ${error?.stack ?? error}`);
            return failure;
        } finally {
            running = false;
        }
    }

    return {
        runOnce,
        revertLast,
        audit,
        getStatus: () => ({ lastResult, running, lastArchivedRun }),
    };
}

const plugin = definePluginLocal({
    name: 'session-auto-archive',
    inject: [],
    apply(ctx, rawConfig) {
        let config = plainConfig(rawConfig ?? {});
        const resolveConfig = () => ({
            enabled: config.enabled !== false,
            idleDays: Number.isFinite(config.idleDays) ? config.idleDays : 14,
            dryRun: config.dryRun !== false,
            keepPinned: config.keepPinned !== false,
            includeSubagents: config.includeSubagents === true,
            autoUnarchive: config.autoUnarchive !== false,
            intervalHours: Number.isFinite(config.intervalHours) ? config.intervalHours : 12,
            startupDelayMs: Number.isFinite(config.startupDelayMs) ? config.startupDelayMs : 60_000,
            excludeCwdSubstrings: Array.isArray(config.excludeCwdSubstrings) ? config.excludeCwdSubstrings : [],
        });

        // 配置持久化：插件自持一个 config.json（宿主 settings 的 entry id 由 loader
        // 分配、bundle patch 场景下不可靠，早先 /settings 404 就是这个原因）。
        // 优先级：config.json > cordis.patch.yml 的 config: > schema 默认值。
        const configDir = join(dshHome(), 'storages', 'auto-archive');
        const configFile = join(configDir, 'config.json');
        let configRevision = 'initial';

        const revisionOf = (value) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

        async function loadStoredConfig() {
            try {
                if (!existsSync(configFile)) return;
                const stored = JSON.parse(await readFile(configFile, 'utf8'));
                if (stored && typeof stored === 'object') {
                    config = { ...config, ...plainConfig(stored) };
                    configRevision = revisionOf(stored);
                    ctx.logger?.info?.(`${LOG_PREFIX} config loaded from ${configFile}`);
                }
            } catch (error) {
                ctx.logger?.warn?.(`${LOG_PREFIX} config load failed: ${error?.message ?? error}`);
            }
        }

        async function storeConfig(patch) {
            const next = { ...resolveConfig(), ...patch };
            await mkdir(configDir, { recursive: true });
            await writeFile(configFile, JSON.stringify(next, null, 2), 'utf8');
            config = { ...config, ...next };
            configRevision = revisionOf(next);
            return next;
        }

        void loadStoredConfig();

        const runner = makeRunner(ctx, resolveConfig);

        // 定时器：启动延迟 + 固定间隔；unref 不阻止进程退出；fiber 卸载时清理。
        ctx.effect(() => {
            let timer;
            const scheduleNext = (delay) => {
                timer = setTimeout(() => {
                    void runner.runOnce('timer').finally(() => scheduleNext(resolveConfig().intervalHours * DAY_MS / 24));
                }, delay);
                timer.unref?.();
            };
            // 启动调度不看 enabled：disabled 时 runOnce 自身短路，卡片里改开
            // enabled 也能在下一轮生效（热更新）。
            scheduleNext(resolveConfig().startupDelayMs);
            return () => { if (timer) clearTimeout(timer); };
        }, `${LOG_PREFIX}: timer loop`);

        // 回到会话自动取消归档：宿主只在「用户亲手发的持久消息」落盘后发
        // api-session/activity，而归档会话在 UI 里根本打不开，所以这条事件
        // 只可能来自定时任务 / 目标自动续跑这类后台轮次 —— 正好是需要它回到
        // 列表的场景。取消归档后 updatedAt 已随这条消息刷新，配合「按最近
        // 活跃」排序它会直接排到最上面。
        ctx.effect(() => {
            ctx.on('api-session/activity', (sessionId) => {
                const id = String(sessionId);
                const config = resolveConfig();
                if (!config.enabled || !config.autoUnarchive) return;
                let registry;
                try {
                    registry = getService(ctx, 'workspaceRegistry');
                } catch {
                    return;
                }
                if (!registry || typeof registry.unarchiveSession !== 'function') return;
                const archivedIds = registry.archivedSessionIds;
                const isArchived = Array.isArray(archivedIds)
                    ? archivedIds.includes(id)
                    : typeof archivedIds?.has === 'function' ? archivedIds.has(id) : false;
                if (!isArchived) return;
                void (async () => {
                    try {
                        await registry.unarchiveSession(id);
                        await runner.audit({ at: new Date().toISOString(), sessionId: id, action: 'unarchived', by: 'reactivated' });
                        ctx.logger?.info?.(`${LOG_PREFIX} ${id} 再次产生用户消息，已自动取消归档`);
                    } catch (error) {
                        ctx.logger?.warn?.(`${LOG_PREFIX} auto-unarchive ${id} failed: ${error?.message ?? error}`);
                    }
                })();
            });
        }, `${LOG_PREFIX}: unarchive on reactivation`);

        // loopback API：状态查询 + 手动触发（dryRun 可临时覆盖）。
        ctx.inject(['webServer'], (webCtx) => {
            webCtx.effect(() => {
                const server = webCtx.webServer;
                const json = async (req, res, init, makeBody) => {
                    if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
                    return writeJson(res, init, await makeBody());
                };
                const statusRoute = server.register({
                    path: '/api/dsh-auto-archive/status',
                    handler: async (req, res) => json(req, res, 200, async () => ({ ok: true, version: PKG_VERSION, config: resolveConfig(), ...runner.getStatus() })),
                });
                const settingsRoute = server.register({
                    path: '/api/dsh-auto-archive/settings',
                    handler: async (req, res) => {
                        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
                        if (req.method === 'GET') {
                            await loadStoredConfig();
                            return writeJson(res, 200, { ok: true, ns: 'session-auto-archive', value: resolveConfig(), revision: configRevision });
                        }
                        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'GET or POST only' });
                        let body = {};
                        try {
                            const chunks = [];
                            let size = 0;
                            for await (const chunk of req) { chunks.push(chunk); size += chunk.length; if (size > 64 * 1024) break; }
                            if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        } catch { return writeJson(res, 400, { ok: false, error: 'invalid json body' }); }
                        const patch = body?.patch && typeof body.patch === 'object' ? body.patch : null;
                        if (!patch) return writeJson(res, 400, { ok: false, error: 'body.patch object required' });
                        // 乐观并发：客户端带的 revision 过期 → 409，让它重新 GET。
                        await loadStoredConfig();
                        if (typeof body.expectedRevision === 'string' && body.expectedRevision !== configRevision) {
                            return writeJson(res, 409, { ok: false, conflict: true, error: 'revision conflict', revision: configRevision, value: resolveConfig() });
                        }
                        const allowed = new Set(['enabled', 'idleDays', 'dryRun', 'keepPinned', 'includeSubagents', 'autoUnarchive', 'intervalHours', 'startupDelayMs', 'excludeCwdSubstrings']);
                        const clean = {};
                        for (const [key, value] of Object.entries(patch)) {
                            if (!allowed.has(key)) return writeJson(res, 400, { ok: false, error: `unknown config field '${key}'` });
                            if (key === 'enabled' || key === 'dryRun' || key === 'keepPinned' || key === 'includeSubagents' || key === 'autoUnarchive') {
                                if (typeof value !== 'boolean') return writeJson(res, 400, { ok: false, error: `${key} must be boolean` });
                                clean[key] = value;
                            } else if (key === 'excludeCwdSubstrings') {
                                if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return writeJson(res, 400, { ok: false, error: 'excludeCwdSubstrings must be string[]' });
                                clean[key] = value.map((v) => v.trim()).filter(Boolean);
                            } else {
                                const n = Number(value);
                                const min = key === 'idleDays' ? 0.5 : key === 'intervalHours' ? 0.25 : 0;
                                if (!Number.isFinite(n) || n < min) return writeJson(res, 400, { ok: false, error: `${key} must be >= ${min}` });
                                clean[key] = n;
                            }
                        }
                        try {
                            const next = await storeConfig(clean);
                            ctx.logger?.info?.(`${LOG_PREFIX} config updated: ${JSON.stringify(clean)}`);
                            return writeJson(res, 200, { ok: true, ns: 'session-auto-archive', value: next, revision: configRevision });
                        } catch (error) {
                            return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
                        }
                    },
                });
                const runRoute = server.register({
                    path: '/api/dsh-auto-archive/run',
                    handler: async (req, res) => {
                        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
                        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' });
                        let body = {};
                        try {
                            const chunks = [];
                            let size = 0;
                            for await (const chunk of req) { chunks.push(chunk); size += chunk.length; if (size > 64 * 1024) break; }
                            if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        } catch { /* 空/坏 body 走默认 */ }
                        // 一次性覆盖（dryRun/idleDays/allowLive/onlySessionId）由 runOnce 内部
                        // 合并，不再临时改共享 config（避免并发窗口互相污染）。
                        const result = await runner.runOnce('api', body);
                        return writeJson(res, 200, { ok: result.ok !== false, result });
                    },
                });
                const revertRoute = server.register({
                    path: '/api/dsh-auto-archive/revert',
                    handler: async (req, res) => {
                        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
                        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' });
                        let body = {};
                        try {
                            const chunks = [];
                            let size = 0;
                            for await (const chunk of req) { chunks.push(chunk); size += chunk.length; if (size > 64 * 1024) break; }
                            if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        } catch { /* 空 body = 撤销最近一次整批 */ }
                        try {
                            const out = await runner.revertLast(typeof body?.sessionId === 'string' ? body.sessionId : undefined);
                            return writeJson(res, 200, { ok: true, ...out, revertedCount: out.reverted.length });
                        } catch (error) {
                            return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
                        }
                    },
                });
                // 归档历史：audit.log 倒序返回，并用 projcache 的 title 富化每条记录。
                const historyRoute = server.register({
                    path: '/api/dsh-auto-archive/history',
                    handler: async (req, res) => {
                        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
                        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET only' });
                        try {
                            const home = dshHome();
                            const auditFile = join(home, 'storages', 'auto-archive', 'audit.log');
                            let limit = 50;
                            try {
                                const u = new URL(req.url || '', 'http://127.0.0.1');
                                const n = Number(u.searchParams.get('limit'));
                                if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 200);
                            } catch { /* 坏 query 用默认 limit */ }
                            let lines = [];
                            if (existsSync(auditFile)) lines = (await readFile(auditFile, 'utf8')).split('\n').filter(Boolean);
                            const recent = lines.slice(-limit).reverse();
                            const titleCache = new Map();
                            const readTitle = async (sessionId) => {
                                if (titleCache.has(sessionId)) return titleCache.get(sessionId);
                                let title;
                                for (const name of [sessionId, String(sessionId).replace(/^session-/, '')]) {
                                    const file = join(home, 'storages', 'session_projcache', 'sessions', `${name}.json`);
                                    if (!existsSync(file)) continue;
                                    try {
                                        const parsed = JSON.parse(await readFile(file, 'utf8'));
                                        const val = parsed?.record?.rows?.title?.val;
                                        if (typeof val === 'string' && val) { title = val; break; }
                                    } catch { /* 坏文件：没标题就用 sessionId */ }
                                }
                                titleCache.set(sessionId, title);
                                return title;
                            };
                            const entries = [];
                            for (const line of recent) {
                                let item;
                                try { item = JSON.parse(line); } catch { continue; }
                                const entry = {
                                    action: item.action, at: item.at, sessionId: item.sessionId,
                                    cwd: item.cwd, idleDays: item.idleDays, lastActivity: item.lastActivity,
                                    dryRun: item.dryRun, by: item.by, error: item.error,
                                };
                                if (item.sessionId) entry.title = await readTitle(item.sessionId);
                                entries.push(entry);
                            }
                            return writeJson(res, 200, { ok: true, entries, total: lines.length });
                        } catch (error) {
                            return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
                        }
                    },
                });
                return () => { statusRoute?.(); settingsRoute?.(); runRoute?.(); revertRoute?.(); historyRoute?.(); };
            }, `${LOG_PREFIX}: routes`);
        });

        ctx.logger?.info?.(`${LOG_PREFIX} loaded v${PKG_VERSION} (dryRun default: ${config.dryRun !== false})`);
    },
});

export const { name, inject, apply } = plugin;
export default plugin;

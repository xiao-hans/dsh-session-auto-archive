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
 * excludeCwdSubstrings 排除整个工作区。非 dryRun 时先在
 * <storeDir>/archive/<id>/ 完整备份原始日志、projcache 与工作区归属，再改归档
 * 状态；备份缺失/校验失败/无真实对话事件的会话拒绝归档，保证撤销可 resume。
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
import { createReverter, encodeSegment } from './session-restore.mjs';

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
    const sessionsRoot = join(home, 'sessions');
    let running = false;
    let lastResult = undefined;
    let lastArchivedRun = undefined; // { at, sessionIds[] } 供一键撤销；由 reverter.readLastBatch() 从盘上镜像

    // 撤销必须能 resume 原对话：归档前由 createReverter 备份完整
    // session.v4.jsonl.zstd 与 projcache，撤销时校验 SHA-256 / 真实对话事件后
    // 逐字节还原，再解除归档标志并用 attachSession() 补工作区槽位。绝不用
    // header-only stub 冒充恢复。批次落盘后重启仍可一键撤销。
    // 手动归档（DSH 侧栏 Archive 按钮）不经过本插件，旧版既没有备份也没有
    // 审计，宿主清理日志后就永久丢失。宿主把 service 上的方法设为只读，没法
    // 包 archiveSession，所以改看 global.archivedSessionIds：发现新归档的 id
    // 且没有备份时立刻补一份完整备份。pluginArchiving 用来跳过本插件自己触发
    // 的归档，避免同一次归档备份两遍。
    const watchState = { running: false, error: null, lastScanAt: null };
    const pluginArchiving = new Set();
    const reverter = createReverter({
        ctx,
        getRegistry: () => getService(ctx, 'workspaceRegistry'),
        storeDir,
        projcacheDir,
        sessionsRoot,
        audit: (line) => audit(line),
    });
    // 启动时把「上次批量」从 last-archive.json / audit.log 恢复到内存，
    // 让状态接口与「撤销上次批量」按钮在插件重启后依旧可用。
    void reverter.readLastBatch()
        .then((batch) => { if (batch) lastArchivedRun = batch; })
        .catch(() => {});

    async function revertLast(sessionId, options) {
        const out = await reverter.revert(sessionId, options);
        lastArchivedRun = (await reverter.readLastBatch()) ?? lastArchivedRun;
        return out;
    }

    const audit = async (line) => {
        try {
            await mkdir(storeDir, { recursive: true });
            await appendFile(join(storeDir, 'audit.log'), `${JSON.stringify(line)}\n`, 'utf8');
        } catch (error) {
            ctx.logger?.warn?.(`${LOG_PREFIX} audit write failed: ${error?.stack ?? error}`);
        }
    };

    /** 手动归档前的完整备份。日志不存在/只是空壳时不阻止归档（没有对话可丢），
     *  但其它备份失败必须抛出，宁可让用户看到归档失败也不静默丢数据。 */
    async function prepareManualArchive(id, registry, by = 'manual') {
        const persistence = getService(ctx, 'sessionPersistence');
        if (!persistence || typeof persistence.list !== 'function') return { backup: null, reason: 'no-persistence-service' };
        const snapshots = await persistence.list();
        const snapshot = (snapshots ?? []).find((s) => s?.header?.id === id);
        if (!snapshot?.location?.path) return { backup: null, reason: 'no-log' };
        let logSha;
        try {
            logSha = createHash('sha256').update(await readFile(snapshot.location.path)).digest('hex');
        } catch (error) {
            if (String(error?.code ?? '') === 'ENOENT') return { backup: null, reason: 'no-log' };
            throw error;
        }
        try {
            const backup = await reverter.backup(id, snapshot, { registry, cwd: snapshot.header?.cwd, by, expectSha256: logSha });
            return { backup, cwd: snapshot.header?.cwd, reason: 'backed-up' };
        } catch (error) {
            const message = String(error?.message ?? error);
            // 没对话事件的会话没有可恢复内容，允许归档；但不能写假备份。
            if (/no conversational events/i.test(message)) return { backup: null, cwd: snapshot.header?.cwd, reason: 'empty-shell' };
            throw error;
        }
    }

    async function noteManualArchive(id, prepared, by = 'manual') {
        const at = new Date().toISOString();
        const backup = prepared?.backup
            ? { sha256: prepared.backup.log.sha256, bytes: prepared.backup.log.bytes, events: prepared.backup.log.conversational }
            : null;
        await audit({ action: 'archived', at, sessionId: id, by, dryRun: false, cwd: prepared?.cwd, backup, guard: prepared?.reason ?? 'unknown' });
        try {
            lastArchivedRun = await reverter.recordBatch(at, [id]);
        } catch (error) {
            ctx.logger?.warn?.(`${LOG_PREFIX} record ${by} batch failed: ${error?.message ?? error}`);
        }
    }

    async function noteManualArchiveFailure(id, error, prepared, by = 'manual') {
        await audit({
            action: 'failed', at: new Date().toISOString(), sessionId: id, by, dryRun: false,
            cwd: prepared?.cwd, error: String(error?.message ?? error),
        });
    }

    function hasBackup(id) {
        return existsSync(join(storeDir, 'archive', encodeSegment(String(id)), 'manifest.json'));
    }

    /** 本插件自己归档时跳过手动守卫；否则会备份两遍。 */
    async function archiveSessionByPlugin(registry, id) {
        pluginArchiving.add(id);
        try {
            await registry.archiveSession(id);
        } finally {
            pluginArchiving.delete(id);
        }
    }

    /** 主动归档：先备份，再调宿主，最后写审计。备份失败就不归档。 */
    async function archiveManually(id) {
        const registry = getService(ctx, 'workspaceRegistry');
        if (!registry || typeof registry.archiveSession !== 'function') throw new Error('workspaceRegistry.archiveSession not available');
        const prepared = await prepareManualArchive(id, registry);
        pluginArchiving.add(id);
        try {
            await registry.archiveSession(id);
        } catch (error) {
            await noteManualArchiveFailure(id, error, prepared);
            throw error;
        } finally {
            pluginArchiving.delete(id);
        }
        await noteManualArchive(id, prepared);
        return { ok: true, sessionId: id, backedUp: !!prepared?.backup, guard: prepared?.reason ?? 'unknown' };
    }

    /** 诊断用：直接调宿主归档、不做前置备份，让 2 秒轮询的 watcher 补备份。
     *  用来验证「侧栏手动归档」那条路径。 */
    async function archiveRaw(id) {
        const registry = getService(ctx, 'workspaceRegistry');
        if (!registry || typeof registry.archiveSession !== 'function') throw new Error('workspaceRegistry.archiveSession not available');
        await registry.archiveSession(id);
        return { ok: true, raw: true, sessionId: id };
    }

    /** 侧栏手动归档不经过插件：轮询 archivedSessionIds，新出现的 id 若没有
     *  备份就立刻补备份。日志在归档后仍然留在盘上，所以这里来得及。 */
    async function scanNewArchives(seen) {
        const registry = getService(ctx, 'workspaceRegistry');
        if (!registry) return;
        const raw = registry.archivedSessionIds;
        const ids = Array.isArray(raw) ? raw : raw && typeof raw[Symbol.iterator] === 'function' ? [...raw] : [];
        const current = new Set(ids.map(String));
        if (seen.size === 0) { for (const id of current) seen.add(id); return; }
        const added = [...current].filter((id) => !seen.has(id));
        for (const id of [...seen]) if (!current.has(id)) seen.delete(id);
        for (const id of added) seen.add(id);
        watchState.lastScanAt = new Date().toISOString();
        for (const id of added) {
            if (pluginArchiving.has(id) || hasBackup(id)) continue;
            try {
                const prepared = await prepareManualArchive(id, registry, 'watch');
                if (prepared.backup) {
                    await noteManualArchive(id, prepared, 'watch');
                } else {
                    await audit({ action: 'archived-unbacked', at: new Date().toISOString(), sessionId: id, by: 'watch', reason: prepared.reason, cwd: prepared.cwd });
                }
            } catch (error) {
                watchState.error = `backup ${id} failed: ${error?.message ?? error}`;
                await audit({ action: 'failed', at: new Date().toISOString(), sessionId: id, by: 'watch', error: String(error?.message ?? error) });
            }
        }
    }

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
                    // 先完整备份，再改变归档状态。备份失败/日志没有真实对话事件
                    // 时拒绝归档：否则撤销后点开只会得到空白会话，无法 resume。
                    if (!snapshot?.location?.path) throw new Error('sessionPersistence.list() did not provide location.path');
                    const logSha = createHash('sha256').update(await readFile(snapshot.location.path)).digest('hex');
                    const backup = await reverter.backup(id, snapshot, { registry, cwd: header.cwd, by: trigger, expectSha256: logSha });
                    await archiveSessionByPlugin(registry, id);
                    archived.add(id);
                    result.archived += 1;
                    newlyArchived.push(id);
                    await audit({ action: 'archived', ...entry, backup: { sha256: backup.log.sha256, bytes: backup.log.bytes, events: backup.log.conversational } });
                } catch (error) {
                    // 备份失败/WorkspaceActiveSessionError 等：会话保持未归档。
                    result.errors.push({ sessionId: id, stage: 'backup-or-archive', message: String(error?.message ?? error) });
                    await audit({ action: 'failed', ...entry, error: String(error?.message ?? error) });
                }
            }
            result.durationMs = Date.now() - startedAt;
            result.newlyArchived = newlyArchived;
            lastResult = result;
            if (!config.dryRun && newlyArchived.length) {
                lastArchivedRun = await reverter.recordBatch(result.at, newlyArchived);
            }
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
        prepareManualArchive,
        noteManualArchive,
        noteManualArchiveFailure,
        archiveManually,
        archiveRaw,
        scanNewArchives,
        isPluginArchiving: (id) => pluginArchiving.has(id),
        markWatch: (running, error = null) => { watchState.running = running === true; watchState.error = error ? String(error) : null; },
        getStatus: () => ({ lastResult, running, lastArchivedRun, archiveWatcher: watchState.running, archiveWatcherError: watchState.error, lastWatchScanAt: watchState.lastScanAt }),
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

        // 侧栏 Archive 按钮走 WorkspaceController → RPC → 宿主 registry，
        // 但 registry.archiveSession 在服务对象上是只读的，包不住。改为轮询
        // global.archivedSessionIds：发现新归档且没有备份的 id 就补一份完整
        // 备份。归档后原始日志仍留在盘上，2 秒内的补备份是完整的。
        ctx.effect(() => {
            const seen = new Set();
            let busy = false;
            const tick = async () => {
                if (busy) return;
                busy = true;
                try {
                    await runner.scanNewArchives(seen);
                    runner.markWatch(true, null);
                } catch (error) {
                    runner.markWatch(false, String(error?.message ?? error));
                    ctx.logger?.warn?.(`${LOG_PREFIX} archive watcher failed: ${error?.stack ?? error}`);
                } finally {
                    busy = false;
                }
            };
            void tick();
            const timer = setInterval(() => { void tick(); }, 2000);
            timer.unref?.();
            return () => { clearInterval(timer); runner.markWatch(false, null); };
        }, `${LOG_PREFIX}: manual archive watcher`);

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
                        // 不能只 unarchiveSession：必须校验并还原完整备份，
                        // 再 attachSession 回原工作区，否则点开是空会话、无法 resume。
                        await runner.revertLast(id, { by: 'reactivated' });
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
                const archiveRoute = server.register({
                    path: '/api/dsh-auto-archive/archive',
                    handler: async (req, res) => {
                        if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
                        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' });
                        let body = {};
                        try {
                            const chunks = [];
                            let size = 0;
                            for await (const chunk of req) { chunks.push(chunk); size += chunk.length; if (size > 64 * 1024) break; }
                            if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        } catch { return writeJson(res, 400, { ok: false, error: 'invalid json body' }); }
                        const id = typeof body?.sessionId === 'string' ? body.sessionId : '';
                        if (!id) return writeJson(res, 400, { ok: false, error: 'body.sessionId required' });
                        // 走 registry.archiveSession；默认先备份。raw:true 只用于验证 watcher。
                        try {
                            if (body?.raw === true) return writeJson(res, 200, await runner.archiveRaw(id));
                            return writeJson(res, 200, await runner.archiveManually(id));
                        } catch (error) {
                            return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
                        }
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
                            return writeJson(res, 200, {
                                ok: true,
                                ...out,
                                revertedCount: out.reverted.length,
                                restoredCount: (out.restored ?? []).length,
                                resumableCount: (out.details ?? []).filter((d) => d?.resumable === true).length,
                                skippedCount: (out.skipped ?? []).length,
                                warningCount: (out.warnings ?? []).length,
                            });
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
                                    restoredFrom: item.restoredFrom,
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
                return () => { statusRoute?.(); settingsRoute?.(); runRoute?.(); archiveRoute?.(); revertRoute?.(); historyRoute?.(); };
            }, `${LOG_PREFIX}: routes`);
        });

        ctx.logger?.info?.(`${LOG_PREFIX} loaded v${PKG_VERSION} (dryRun default: ${config.dryRun !== false})`);
    },
});

export const { name, inject, apply } = plugin;
export default plugin;

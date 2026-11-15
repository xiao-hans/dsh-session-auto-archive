/**
 * dsh-session-auto-archive / lib/session-restore.mjs
 *
 * 归档前完整备份 + 撤销时逐字节还原。宿主 unarchiveSession() 只删除
 * global.archivedSessionIds 里的 id；若原始 session.v4.jsonl.zstd 不在磁盘上，
 * 恢复出来的只能是一个没有历史事件的空白会话。header-only stub 绝不能冒充
 * 「恢复」：它只让侧栏多一个条目，点进去无法 resume。
 *
 * 归档时把原始日志、projcache 与工作区归属快照写入
 * <storeDir>/archive/<encoded-session-id>/，记录 SHA-256 / 字节数 / 日志事件
 * 统计。撤销时先校验备份完整性（含真实对话事件），再原子还原原始字节，最后
 * 才解除归档标志、attachSession() 补工作区槽位并刷新前端视图。没有通过校验
 * 的备份一律拒绝恢复，不写空壳、不污染工作区。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';

/** 与 dsh-session-persistence-jsonl 的 encodeSegment 逐字一致。 */
export function encodeSegment(raw) {
    if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment');
    if (raw === '.') return '~002E';
    if (raw === '..') return '~002E~002E';
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
        else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
    return out;
}

/** 与 dsh-session-persistence-jsonl 的 projectKey 逐字一致。 */
export function projectKey(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path');
    let readable = '';
    let separatorRun = false;
    for (let i = 0; i < cwd.length; i++) {
        const code = cwd.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if (/[/\\:]/.test(ch)) {
            if (!separatorRun) readable += '-';
            separatorRun = true;
        } else if (ch !== '~' && /[A-Za-z0-9._-]/.test(ch)) {
            readable += ch;
            separatorRun = false;
        } else {
            readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
            separatorRun = false;
        }
    }
    return '--' + readable.slice(0, 251) + '--';
}

/** 会话日志默认落点，与 dsh-session-persistence-jsonl 一致。 */
export function sessionLogPath(root, cwd, id) {
    return join(root, projectKey(cwd), encodeSegment(id), 'session.v4.jsonl.zstd');
}

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

/** 解析一个 zstd frame 的结束位置（RFC 8878），不依赖解压器是否读多 frame。 */
function zstdFrameEnd(buf, start) {
    let p = start + 4;
    if (p >= buf.length) throw new Error('truncated zstd frame header');
    const fhd = buf[p++];
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!singleSegment) p += 1;
    p += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4;
    p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    for (;;) {
        if (p + 3 > buf.length) throw new Error('truncated zstd block header');
        const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
        p += 3;
        const last = h & 1;
        const type = (h >> 1) & 3;
        const size = h >>> 3;
        if (type === 3) throw new Error('reserved zstd block type');
        p += type === 1 ? 1 : size;
        if (last) break;
    }
    if (checksum) p += 4;
    if (p > buf.length) throw new Error('truncated zstd frame');
    return p;
}

/** 把拼接的 zstd frame 切开；兼容 skippable frame。 */
function splitZstdFrames(raw) {
    const frames = [];
    let off = 0;
    while (off < raw.length) {
        if (off + 4 > raw.length) throw new Error('truncated zstd magic');
        const magic = raw.readUInt32LE(off);
        if (magic === ZSTD_MAGIC) {
            const end = zstdFrameEnd(raw, off);
            frames.push(raw.subarray(off, end));
            off = end;
        } else if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
            if (off + 8 > raw.length) throw new Error('truncated zstd skippable frame');
            off += 8 + raw.readUInt32LE(off + 4);
        } else {
            throw new Error('not a zstd frame');
        }
    }
    if (frames.length === 0) throw new Error('no zstd frame');
    return frames;
}

/**
 * 会话日志是多个 zstd frame 拼接的。Electron 自带的 Node 里
 * zstdDecompressSync()/流式解压都可能只解第一个 frame（只剩 header 一行），
 * 所以先按 RFC 8878 切帧逐个解压；失败再退回单帧/流式解压。
 */
async function zstdText(raw) {
    try {
        const frames = splitZstdFrames(raw);
        if (frames.length > 1) {
            return frames.map((frame) => zstdDecompressSync(frame).toString('utf8')).join('');
        }
    } catch { /* 非法边界：走下面的兜底 */ }
    let syncText;
    try { syncText = zstdDecompressSync(raw).toString('utf8'); } catch { syncText = ''; }
    let streamText;
    try {
        const chunks = [];
        await new Promise((resolve, reject) => {
            const d = createZstdDecompress();
            d.on('data', (chunk) => chunks.push(chunk));
            d.on('end', resolve);
            d.on('error', reject);
            d.end(raw);
        });
        streamText = Buffer.concat(chunks).toString('utf8');
    } catch { streamText = ''; }
    if (!syncText && !streamText) throw new Error('session log is not readable zstd');
    return streamText.length >= syncText.length ? streamText : syncText;
}

/** 已证伪的 stub 构造不再导出；保留判据用于拒绝空壳备份/现有空壳日志。 */
export async function inspectSessionLog(raw) {
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw new Error('session log is empty');
    const text = await zstdText(raw);
    const lines = text.split(/\r?\n/).filter(Boolean);
    let header;
    const counts = {};
    for (const line of lines) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (!header && item?.type === 'session') header = item;
        if (typeof item?.type === 'string') counts[item.type] = (counts[item.type] ?? 0) + 1;
    }
    if (!header || header.version !== 4) throw new Error('session log has no valid v4 header');
    const conversational = (counts['user/message'] ?? 0) + (counts['assistant/message'] ?? 0)
        + (counts['tool/call'] ?? 0) + (counts['tool/result'] ?? 0);
    return { lines: lines.length, header, counts, conversational, bytes: raw.length };
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const BATCH_WINDOW_MS = 5 * 60 * 1000;
const BATCH_FILE = 'last-archive.json';
const ARCHIVE_DIR = 'archive';
const LOG_NAME = 'session.v4.jsonl.zstd';
const PROJCACHE_NAME = 'projection.json';
const MANIFEST_NAME = 'manifest.json';

/**
 * @param {object} opts
 * @param {object} opts.ctx Cordis 上下文
 * @param {string} opts.storeDir ~/.dsh/storages/auto-archive
 * @param {string} opts.projcacheDir ~/.dsh/storages/session_projcache/sessions
 * @param {string} opts.sessionsRoot ~/.dsh/sessions
 * @param {function} [opts.audit] 审计写入函数
 */
export function createReverter(opts = {}) {
    const { ctx = {}, storeDir, projcacheDir, sessionsRoot, audit } = opts;
    const writeAudit = typeof audit === 'function' ? audit : async () => {};
    let inMemoryBatch;

    const getRegistry = () => {
        const registry = opts.getRegistry?.() ?? opts.registry ?? ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
        if (!registry || typeof registry.unarchiveSession !== 'function') {
            throw new Error('workspaceRegistry.unarchiveSession not available on ctx');
        }
        return registry;
    };
    const getService = (name) => ctx.get?.(name) ?? ctx[name];
    const backupDir = (id) => join(storeDir, ARCHIVE_DIR, encodeSegment(String(id)));
    /** 覆盖备份前先移除旧文件，避免旧版 stash 被当作可恢复数据留下。 */
    async function writeStaged(dir, name, raw) {
        const target = join(dir, name);
        try { await unlink(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        const tmp = join(dir, `${name}.tmp-${process.pid}-${Date.now()}`);
        await writeFile(tmp, raw, { flag: 'wx' });
        await rename(tmp, target);
    }
    const projcachePath = async (id) => {
        for (const name of [String(id), String(id).replace(/^session-/, '')]) {
            const file = join(projcacheDir, `${name}.json`);
            if (existsSync(file)) return file;
        }
        return undefined;
    };

    const viewOf = (workspace) => {
        const record = workspace?.record ?? workspace;
        return {
            workspaceId: workspace?.workspaceId ?? workspace?.id,
            path: record?.path,
            title: record?.title ?? '',
            sessionIds: [...(record?.sessionIds ?? [])],
            createdAt: workspace?.createdAt ?? record?.createdAt,
            updatedAt: workspace?.updatedAt ?? record?.updatedAt,
        };
    };

    const normalizePath = (value) => typeof value === 'string'
        ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        : '';

    /** 原始工作区记录；不能用 entity.sessionIds（已被 candidateMatches 过滤）。 */
    const listWorkspaceRecords = (registry) => {
        const out = [];
        const seen = new Set();
        const push = (id, record) => {
            if (typeof id !== 'string' || !record || typeof record !== 'object' || seen.has(id)) return;
            seen.add(id);
            out.push({ id, record });
        };
        try {
            const table = registry.requireTable?.();
            if (table) {
                const entries = typeof table.entries === 'function' ? table.entries() : undefined;
                if (entries) for (const [id, record] of entries) push(id, record);
                if (out.length === 0) {
                    const ids = registry.requireState?.()?.workspaceIds ?? [];
                    for (const id of ids) push(id, table.get?.(id));
                }
            }
        } catch { /* 服务未就绪时走 list() 兜底 */ }
        if (out.length === 0) {
            try {
                for (const workspace of registry.list?.() ?? []) {
                    push(workspace?.id ?? workspace?.workspaceId, workspace?.record ?? workspace);
                }
            } catch { /* ignore */ }
        }
        return out;
    };

    /** 最后兜底：直接读 storages/workspace.json。 */
    async function readWorkspaceRecordsFromDisk() {
        const candidates = [];
        if (storeDir) candidates.push(join(storeDir, '..', 'workspace.json'));
        if (projcacheDir) candidates.push(join(projcacheDir, '..', 'workspace.json'));
        for (const file of [...new Set(candidates)]) {
            try {
                const parsed = JSON.parse(await readFile(file, 'utf8'));
                const table = parsed?.tables?.workspaces ?? parsed?.workspaces;
                if (!table || typeof table !== 'object') continue;
                const out = [];
                for (const [id, record] of Object.entries(table)) {
                    if (record && typeof record === 'object') out.push({ id, record });
                }
                if (out.length) return out;
            } catch { /* 试下一个路径 */ }
        }
        return [];
    }

    function findWorkspaceRecord(records, id, cwd) {
        const direct = records.find((entry) => Array.isArray(entry.record?.sessionIds)
            && entry.record.sessionIds.includes(id));
        if (direct) return direct;
        const key = normalizePath(cwd);
        if (!key) return undefined;
        return records.find((entry) => normalizePath(entry.record?.path) === key);
    }

    async function batchFromAudit() {
        let lines;
        try { lines = (await readFile(join(storeDir, 'audit.log'), 'utf8')).split('\n').filter(Boolean); }
        catch { return undefined; }
        const ids = [];
        let anchor = null;
        for (let i = lines.length - 1; i >= 0; i--) {
            let item;
            try { item = JSON.parse(lines[i]); } catch { continue; }
            if (item?.action !== 'archived') {
                if (ids.length) break;
                continue;
            }
            const ts = Date.parse(item.at);
            if (anchor === null && Number.isFinite(ts)) anchor = ts;
            if (anchor !== null && Number.isFinite(ts) && anchor - ts > BATCH_WINDOW_MS) break;
            if (typeof item.sessionId === 'string') ids.unshift(item.sessionId);
        }
        if (!ids.length) return undefined;
        return { at: anchor !== null ? new Date(anchor).toISOString() : undefined, sessionIds: [...new Set(ids)] };
    }

    async function readLastBatch() {
        if (inMemoryBatch) return inMemoryBatch;
        try {
            const parsed = JSON.parse(await readFile(join(storeDir, BATCH_FILE), 'utf8'));
            if (Array.isArray(parsed?.sessionIds) && parsed.sessionIds.length) {
                inMemoryBatch = { at: parsed.at, sessionIds: parsed.sessionIds.map(String) };
                return inMemoryBatch;
            }
        } catch { /* 落盘批次不可用 */ }
        inMemoryBatch = await batchFromAudit();
        return inMemoryBatch;
    }

    async function recordBatch(at, sessionIds) {
        inMemoryBatch = { at, sessionIds: [...sessionIds].map(String) };
        try {
            await mkdir(storeDir, { recursive: true });
            await writeFile(join(storeDir, BATCH_FILE), JSON.stringify(inMemoryBatch), 'utf8');
        } catch (error) {
            ctx.logger?.warn?.('[auto-archive] last-archive.json write failed: ' + (error?.message ?? error));
        }
        return inMemoryBatch;
    }

    /**
     * 归档前备份原日志与投影。必须在 registry.archiveSession() 之前调用；
     * 备份失败时调用方必须拒绝归档，否则会话将无法 resume。
     */
    async function backup(sessionId, snapshot = {}, options = {}) {
        const id = String(sessionId);
        const source = typeof snapshot?.location?.path === 'string'
            ? snapshot.location.path
            : sessionLogPath(sessionsRoot, snapshot?.header?.cwd ?? options.cwd, id);
        const raw = await readFile(source);
        if (options.expectBytes && raw.length !== options.expectBytes) {
            throw new Error(`session log changed before backup: ${source}`);
        }
        if (options.expectSha256 && sha256(raw) !== options.expectSha256) {
            throw new Error(`session log changed before backup: ${source}`);
        }
        const inspection = await inspectSessionLog(raw);
        if (inspection.header.id !== id) throw new Error(`session log id mismatch: ${inspection.header.id}`);
        if (inspection.conversational === 0) {
            throw new Error(`session log has no conversational events; refusing empty-shell backup (${inspection.lines} lines, ${raw.length} bytes) from ${source}`);
        }
        const dir = backupDir(id);
        await mkdir(dir, { recursive: true });
        // 旧版空壳备份不得留下：原日志必须先写临时文件，再原子替换。
        await writeStaged(dir, LOG_NAME, raw);

        const cacheSource = await projcachePath(id);
        let cacheSha;
        if (cacheSource) {
            const cacheRaw = await readFile(cacheSource);
            cacheSha = sha256(cacheRaw);
            await writeStaged(dir, PROJCACHE_NAME, cacheRaw);
        }

        const registry = options.registry ?? (() => { try { return getRegistry(); } catch { return undefined; } })();
        let workspaceRecords = registry ? listWorkspaceRecords(registry) : [];
        if (workspaceRecords.length === 0) workspaceRecords = await readWorkspaceRecordsFromDisk();
        const entry = findWorkspaceRecord(workspaceRecords, id, inspection.header.cwd);
        const workspacePath = typeof entry?.record?.path === 'string' ? entry.record.path : inspection.header.cwd;
        const manifest = {
            version: 1,
            sessionId: id,
            at: new Date().toISOString(),
            source,
            restorePath: sessionLogPath(sessionsRoot, workspacePath, id),
            cwd: workspacePath,
            workspaceId: entry?.id,
            workspaceSessionIds: Array.isArray(entry?.record?.sessionIds) ? [...entry.record.sessionIds] : undefined,
            log: { bytes: raw.length, sha256: sha256(raw), lines: inspection.lines, counts: inspection.counts, conversational: inspection.conversational, header: inspection.header },
            projcache: cacheSha ? { path: cacheSource, bytes: (await stat(join(dir, PROJCACHE_NAME))).size, sha256: cacheSha } : undefined,
            by: options.by ?? 'auto',
        };
        await writeFile(join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
        await writeAudit({
            at: manifest.at, sessionId: id, action: 'backed-up', by: manifest.by,
            bytes: raw.length, sha256: manifest.log.sha256, events: inspection.conversational,
            cwd: workspacePath, workspaceId: entry?.id,
        });
        return manifest;
    }

    async function readBackup(id) {
        const dir = backupDir(id);
        const manifest = JSON.parse(await readFile(join(dir, MANIFEST_NAME), 'utf8'));
        const log = await readFile(join(dir, LOG_NAME));
        if (log.length !== manifest.log.bytes || sha256(log) !== manifest.log.sha256) {
            throw new Error(`backup log checksum mismatch for ${id}`);
        }
        const inspection = await inspectSessionLog(log);
        if (inspection.header.id !== id || inspection.conversational === 0) {
            throw new Error(`backup log is not a resumable conversation for ${id}`);
        }
        let projcache;
        if (manifest.projcache) {
            const cache = await readFile(join(dir, PROJCACHE_NAME));
            if (cache.length !== manifest.projcache.bytes || sha256(cache) !== manifest.projcache.sha256) {
                throw new Error(`backup projection checksum mismatch for ${id}`);
            }
            projcache = cache;
        }
        return { manifest, log, projcache, inspection };
    }

    /** 原子还原：先写同目录临时文件并校验，再 rename 到目标位置。 */
    async function restoreFile(target, raw, { allowReplace = false, label = 'file', beforeReplace } = {}) {
        const existing = existsSync(target);
        if (existing && !allowReplace) {
            const current = await readFile(target);
            if (current.equals(raw)) return 'identical';
            // 现有文件不同：绝不覆盖用户数据；调用方按不可恢复处理。
            throw new Error(`${label} already exists with different content: ${target}`);
        }
        await mkdir(dirname(target), { recursive: true });
        const tmp = join(dirname(target), `.${label}.${process.pid}.${Date.now()}.tmp`);
        try {
            await writeFile(tmp, raw, { flag: 'wx' });
            if (typeof beforeReplace === 'function') await beforeReplace();
            await rename(tmp, target);
        } catch (error) {
            try { await unlink(tmp); } catch { /* 清理失败不覆盖原错误 */ }
            throw error;
        }
        return existing ? 'replaced' : 'restored';
    }

    async function knownSessionIds() {
        const set = new Set();
        try {
            const records = await getService('sessionQuery')?.listSessions?.();
            for (const record of records ?? []) {
                const id = record?.header?.id ?? record?.id ?? record?.sessionId;
                if (typeof id === 'string') set.add(id);
            }
        } catch { /* 服务不可用时以文件为准 */ }
        return set;
    }

    function projectionValues(projcache) {
        if (!projcache) return {};
        try {
            const parsed = JSON.parse(projcache.toString('utf8'));
            const rows = parsed?.record?.rows ?? {};
            const metadata = rows.sessionListMetadata?.val;
            const title = rows.title?.val;
            const values = {};
            if (metadata && typeof metadata === 'object') values.sessionListMetadata = metadata;
            if (typeof title === 'string' && title) values.title = title;
            return values;
        } catch { return {}; }
    }

    async function refreshVisibility(registry, id, manifest, projcache) {
        const warnings = [];
        let attached = false;
        let workspaceRecords = listWorkspaceRecords(registry);
        if (workspaceRecords.length === 0) workspaceRecords = await readWorkspaceRecordsFromDisk();
        const entry = findWorkspaceRecord(workspaceRecords, id, manifest.cwd)
            ?? (manifest.workspaceId ? workspaceRecords.find((w) => w.id === manifest.workspaceId) : undefined);
        if (!entry) {
            warnings.push({ sessionId: id, reason: 'missing-workspace' });
            return { attached, warnings };
        }
        try {
            registry.host?.rememberSessionPath?.(id, entry.record.path);
        } catch { /* attachSession 会自行索引 */ }
        const entity = registry.get?.(entry.id);
        if (entity && typeof entity.attachSession === 'function') {
            try {
                await entity.attachSession(id);
                attached = true;
            } catch (error) {
                warnings.push({ sessionId: id, reason: 'attach-failed', message: String(error?.message ?? error) });
            }
        } else {
            try {
                const table = registry.requireTable?.();
                if (typeof table?.update === 'function') {
                    await table.update(entry.id, (current) => ({
                        ...current, sessionIds: [id, ...(current?.sessionIds ?? [])],
                        updatedAt: new Date().toISOString(),
                    }));
                    attached = true;
                } else warnings.push({ sessionId: id, reason: 'attach-failed', message: 'attachSession unavailable' });
            } catch (error) {
                warnings.push({ sessionId: id, reason: 'attach-failed', message: String(error?.message ?? error) });
            }
        }
        const known = await knownSessionIds();
        if (!known.has(id)) {
            warnings.push({ sessionId: id, reason: 'session-query-not-indexed' });
        }
        // 宿主 table.update 会发布 upsert；这里用 attach 后的最新记录再发一次幂等帧。
        const current = registry.requireTable?.()?.get?.(entry.id);
        const view = viewOf(entity ?? { id: entry.id, record: current ?? entry.record });
        if (Array.isArray(view.sessionIds) && view.sessionIds.includes(id)) {
            try { getService('workspaceController')?.feed?.publish?.({ type: 'upsert', workspace: view }); }
            catch { /* 事件桥不可用时重启后由磁盘索引 */ }
        }
        // 完整日志已落盘，注入的是备份里的真实摘要（不是空壳占位）；让前端
        // 立即拿到 list.byId[id]，否则 groupByWorkspace 仍会跳过。
        try {
            const header = manifest.log?.header ?? {};
            const metadata = projectionValues(projcache).sessionListMetadata ?? {};
            const createdAt = Number.isSafeInteger(header.createdAt) && header.createdAt > 0 ? header.createdAt : Date.now();
            const lastPromptAt = Number(metadata.lastPromptAt) > 0 ? Number(metadata.lastPromptAt) : 0;
            const values = projectionValues(projcache);
            ctx.emit?.('api-session/added', {
                sessionId: id,
                updatedAt: Math.max(createdAt, lastPromptAt),
                agentAvailable: false,
                formatStatus: 'current',
                running: false,
                blank: metadata.blank === true,
                cwd: manifest.cwd ?? header.cwd,
                projections: { kind: 'cached', asOfSeq: 0, values },
            });
        } catch { /* 事件桥不可用时重启后由磁盘索引 */ }
        return { attached, warnings };
    }

    async function revert(sessionId, options = {}) {
        const registry = getRegistry();
        const batch = await readLastBatch();
        const ids = sessionId ? [String(sessionId)] : (batch?.sessionIds ?? []);
        const archived = new Set(registry.archivedSessionIds ?? []);
        const auditBy = options.by === 'reactivated' ? 'reactivated' : 'revert';
        const reverted = [], restored = [], skipped = [], warnings = [], details = [];

        for (const id of [...new Set(ids)]) {
            let backup;
            try {
                backup = await readBackup(id);
            } catch (error) {
                // 旧版（v0.1.8 及以前）撤销已把归档标志删掉、却没有完整备份。
                // 这里绝不再写空壳；留下明确警告，让 UI 显示「不可恢复」。
                if (!archived.has(id)) {
                    const reason = 'unrecoverable-backup';
                    warnings.push({ sessionId: id, reason, message: String(error?.message ?? error) });
                    details.push({ sessionId: id, restoredFrom: 'none', resumable: false, reason, alreadyUnarchived: true });
                    await writeAudit({ at: new Date().toISOString(), sessionId: id, action: 'restore-failed', by: auditBy, reason, error: String(error?.message ?? error) });
                    continue;
                }
                const reason = 'unrecoverable-backup';
                warnings.push({ sessionId: id, reason, message: String(error?.message ?? error) });
                details.push({ sessionId: id, restoredFrom: 'none', resumable: false, reason });
                await writeAudit({ at: new Date().toISOString(), sessionId: id, action: 'restore-failed', by: auditBy, reason, error: String(error?.message ?? error) });
                continue;
            }

            const { manifest, log, projcache, inspection } = backup;
            const target = manifest.restorePath ?? sessionLogPath(sessionsRoot, manifest.cwd, id);
            let logResult;
            try {
                // 允许替换「已知没有对话事件的空壳」，但先留档；绝不覆盖有真实
                // 对话或无法解析的现有日志（那可能是用户后来写的新数据）。
                let allowReplace = false;
                if (existsSync(target)) {
                    const current = await readFile(target);
                    if (!current.equals(log)) {
                        let currentInspection;
                        try { currentInspection = await inspectSessionLog(current); } catch { currentInspection = undefined; }
                        allowReplace = currentInspection?.conversational === 0;
                    }
                }
                logResult = await restoreFile(target, log, {
                    label: LOG_NAME,
                    allowReplace,
                    beforeReplace: allowReplace && existsSync(target)
                        ? () => copyFile(target, `${target}.pre-restore-${Date.now()}`)
                        : undefined,
                });
            } catch (error) {
                const reason = 'restore-conflict';
                warnings.push({ sessionId: id, reason, message: String(error?.message ?? error) });
                details.push({ sessionId: id, restoredFrom: 'none', resumable: false, reason });
                await writeAudit({ at: new Date().toISOString(), sessionId: id, action: 'restore-failed', by: auditBy, reason, error: String(error?.message ?? error) });
                continue;
            }
            const cacheTarget = join(projcacheDir, `${id}.json`);
            if (projcache) {
                try {
                    // 若当前投影与备份不同，先留档再覆盖；留档失败不写回。
                    const cacheCurrent = existsSync(cacheTarget) ? await readFile(cacheTarget) : undefined;
                    if (!cacheCurrent || !cacheCurrent.equals(projcache)) {
                        await restoreFile(cacheTarget, projcache, {
                            allowReplace: true,
                            label: PROJCACHE_NAME,
                            beforeReplace: cacheCurrent
                                ? () => copyFile(cacheTarget, `${cacheTarget}.pre-restore-${Date.now()}`)
                                : undefined,
                        });
                    }
                } catch (error) {
                    warnings.push({ sessionId: id, reason: 'projection-restore-failed', message: String(error?.message ?? error) });
                }
            } else if (existsSync(cacheTarget)) {
                // 旧版空壳会话可能已把投影污染成 blank/title=null。备份里没有投影时
                // 不删文件（宿主会自行重建），但必须明确告知用户标题/blank 可能不准。
                warnings.push({ sessionId: id, reason: 'projection-not-backed-up' });
            }

            if (archived.has(id)) {
                await registry.unarchiveSession(id);
                reverted.push(id);
            } else {
                skipped.push({ sessionId: id, reason: 'already-unarchived' });
            }
            const visibility = await refreshVisibility(registry, id, manifest, projcache);
            warnings.push(...visibility.warnings);
            restored.push(id);
            details.push({
                sessionId: id,
                restoredFrom: logResult === 'identical' ? 'existing-backup' : 'archive-backup',
                resumable: true,
                bytes: log.length,
                events: inspection.conversational,
                cwd: manifest.cwd,
                attached: visibility.attached,
                ...(archived.has(id) ? {} : { alreadyUnarchived: true }),
            });
            await writeAudit({
                at: new Date().toISOString(), sessionId: id,
                action: archived.has(id) ? 'unarchived' : 'restored', by: auditBy,
                restoredFrom: details.at(-1).restoredFrom, bytes: log.length,
                events: inspection.conversational, resumable: true, cwd: manifest.cwd,
            });
        }
        return { reverted, restored, skipped, warnings, details, at: batch?.at };
    }

    return { backup, readBackup, revert, recordBatch, readLastBatch };
}

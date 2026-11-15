import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
    createReverter,
    encodeSegment,
    inspectSessionLog,
    projectKey,
    sessionLogPath,
} from '../lib/session-restore.mjs';

const GHOST = 'session-e578b1ea-f433-4368-8950-ef117e21c6f7';
const OTHER = 'session-11111111-2222-3333-4444-555555555555';
const WID = 'workspace-ahvideo';
const CWD = 'D:\\workspace\\AHVideo';

function logLines(id, events = 3) {
    const lines = [{
        type: 'session', version: 4, id, createdAt: 1793029223115,
        cwd: CWD, isSeeded: false, delegationDepth: 0, agentPreset: 'ops-ptc',
    }];
    for (let i = 0; i < events; i++) {
        lines.push({
            type: 'user/message', seq: i * 2 + 1, time: 1793029223200 + i,
            data: { message: { role: 'user', content: [{ type: 'text', text: `继续处理会话 ${i}` }] } },
        });
        lines.push({
            type: 'assistant/message', seq: i * 2 + 2, time: 1793029223300 + i,
            data: { message: { role: 'assistant', content: [{ type: 'text', text: `好的 ${i}` }] } },
        });
    }
    return lines;
}

function emptyShellLines(id) {
    return [
        { type: 'session', version: 4, id, createdAt: 1793029223115, cwd: CWD, isSeeded: true, delegationDepth: 0, agentPreset: 'ops-ptc' },
        { type: 'session/end-seed', seq: 1, time: 1793029223200, data: { reason: 'seed' } },
        { type: 'permission/preset', seq: 2, time: 1793029223200, data: { preset: 'default' } },
        { type: 'approval/policy', seq: 3, time: 1793029223200, data: { policy: 'on-request' } },
        { type: 'sandbox/mode', seq: 4, time: 1793029223200, data: { mode: 'workspace-write' } },
    ];
}

const zstd = (lines) => zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8'));

async function writeLog(sessionsRoot, cwd, id, raw) {
    const target = sessionLogPath(sessionsRoot, cwd, id);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw);
    return target;
}

async function writeProjcache(projcacheDir, id, patch = {}) {
    const record = {
        version: 7,
        record: {
            identity: {
                formatVersion: 4, createdAt: 1793029223115, cwd: CWD,
                isSeeded: false, inheritedEventCount: 0, ...patch.identity,
            },
            rows: {
                title: { ver: 1, seq: 3816, val: '视频闪退与站源订阅续' },
                sessionListMetadata: { ver: 1, seq: 3900, val: { blank: false, lastPromptAt: 1793435877681 } },
                agentPreset: { ver: 1, seq: 1, val: 'ops-ptc' },
                ...patch.rows,
            },
        },
    };
    const raw = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
    await writeFile(join(projcacheDir, id + '.json'), raw);
    return raw;
}

/** 模拟宿主 sessionQuery：只认磁盘上能解析出 v4 header 的日志。 */
async function scanSessions(sessionsRoot) {
    const out = [];
    const walk = async (dir) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) { await walk(path); continue; }
            if (entry.name !== 'session.v4.jsonl.zstd') continue;
            try {
                const { header } = await inspectSessionLog(readFileSync(path));
                out.push({ header });
            } catch { /* 空壳/损坏日志不入索引 */ }
        }
    };
    await walk(sessionsRoot);
    return out;
}

async function fixture(opts = {}) {
    const root = await mkdtemp(join(tmpdir(), 'dsha-backup-'));
    const storeDir = join(root, 'store');
    const projcacheDir = join(root, 'projcache');
    const sessionsRoot = join(root, 'sessions');
    for (const dir of [storeDir, projcacheDir, sessionsRoot]) await mkdir(dir, { recursive: true });

    const calls = { unarchive: [], remember: [], attach: [], emit: [], frames: [], audit: [], update: [] };
    const workspaces = opts.workspaces ?? [{ workspaceId: WID, path: CWD, title: 'AHVideo', sessionIds: [GHOST, OTHER] }];
    const entities = new Map();
    for (const workspace of workspaces) {
        entities.set(workspace.workspaceId, {
            id: workspace.workspaceId,
            path: workspace.path,
            title: workspace.title ?? '',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            record: { path: workspace.path, title: workspace.title ?? '', sessionIds: [...workspace.sessionIds] },
            async attachSession(sessionId) {
                calls.attach.push(sessionId);
                if (!this.record.sessionIds.includes(sessionId)) {
                    this.record = { ...this.record, sessionIds: [sessionId, ...this.record.sessionIds] };
                }
            },
        });
    }
    const table = {
        entries: () => [...entities].map(([id, entity]) => [id, entity.record]),
        get: (id) => entities.get(id)?.record,
        update: async (id, mutate) => {
            const entity = entities.get(id);
            if (!entity) throw new Error('missing workspace ' + id);
            entity.record = mutate(entity.record);
            calls.update.push(id);
            return entity.record;
        },
    };
    const sessionQuery = { listSessions: async () => scanSessions(sessionsRoot) };
    const registry = {
        archivedSessionIds: [...(opts.archived ?? [GHOST, OTHER])],
        host: { rememberSessionPath: (id, path) => calls.remember.push([id, path]) },
        get: (id) => entities.get(id),
        list: () => [...entities.values()],
        requireTable: () => table,
        unarchiveSession: async (id) => {
            calls.unarchive.push(id);
            registry.archivedSessionIds = registry.archivedSessionIds.filter((value) => value !== id);
        },
    };
    const ctx = {
        emit: (name, payload) => calls.emit.push([name, payload]),
        get: (name) => name === 'workspaceController'
            ? { feed: { publish: (frame) => calls.frames.push(frame) } }
            : name === 'sessionQuery' ? sessionQuery : undefined,
        sessionQuery,
        logger: { warn() {}, info() {} },
    };
    const audit = async (line) => { calls.audit.push(line); };
    const make = (override = {}) => createReverter({ ctx, registry, storeDir, projcacheDir, sessionsRoot, audit, ...override });
    return { root, storeDir, projcacheDir, sessionsRoot, registry, ctx, calls, make };
}

test('encodeSegment/projectKey/sessionLogPath 与宿主 dsh-session-persistence-jsonl 一致', () => {
    assert.equal(encodeSegment('session-abc'), 'session-abc');
    assert.equal(encodeSegment('a~b'), 'a~007Eb');
    assert.equal(encodeSegment('.'), '~002E');
    assert.equal(projectKey(CWD), '--D-workspace-AHVideo--');
    assert.equal(sessionLogPath('ROOT', CWD, GHOST), join('ROOT', '--D-workspace-AHVideo--', GHOST, 'session.v4.jsonl.zstd'));
});

test('inspectSessionLog 区分真实对话与 header-only 空壳', async () => {
    const real = await inspectSessionLog(zstd(logLines(GHOST, 3)));
    assert.equal(real.header.id, GHOST);
    assert.equal(real.conversational, 6);
    const shell = await inspectSessionLog(zstd(emptyShellLines(GHOST)));
    assert.equal(shell.conversational, 0);
});

test('多 frame 拼接日志必须解析出全部事件，不能只剩 header', async () => {
    const header = logLines(GHOST, 0);
    const events = logLines(GHOST, 3).slice(1);
    const raw = Buffer.concat([zstd(header), zstd(events)]);
    const info = await inspectSessionLog(raw);
    assert.equal(info.header.id, GHOST);
    assert.equal(info.conversational, 6);
    assert.equal(info.lines, 7);
});

test('backup 保存原始日志/投影/manifest，拒绝空壳备份', async () => {
    const f = await fixture();
    const raw = zstd(logLines(GHOST, 3));
    const source = await writeLog(f.sessionsRoot, CWD, GHOST, raw);
    const cacheRaw = await writeProjcache(f.projcacheDir, GHOST);

    const reverter = f.make();
    const manifest = await reverter.backup(GHOST, { location: { path: source }, header: { id: GHOST, cwd: CWD } });
    assert.equal(manifest.log.bytes, raw.length);
    assert.equal(manifest.log.conversational, 6);
    assert.equal(manifest.cwd, CWD);
    assert.equal(manifest.workspaceId, WID);

    const backup = await reverter.readBackup(GHOST);
    assert.deepEqual(backup.log, raw);
    assert.deepEqual(backup.projcache, cacheRaw);
    assert.equal(backup.manifest.log.sha256, manifest.log.sha256);

    const shellSource = await writeLog(f.sessionsRoot, CWD, OTHER, zstd(emptyShellLines(OTHER)));
    await assert.rejects(
        () => reverter.backup(OTHER, { location: { path: shellSource }, header: { id: OTHER, cwd: CWD } }),
        /no conversational events/,
    );
    assert.equal(existsSync(join(f.storeDir, 'archive', encodeSegment(OTHER), 'manifest.json')), false);

    await rm(f.root, { recursive: true, force: true });
});

test('revert 从完整备份逐字节还原日志与投影，解除归档并刷新工作区', async () => {
    const f = await fixture();
    const raw = zstd(logLines(GHOST, 3));
    const source = await writeLog(f.sessionsRoot, CWD, GHOST, raw);
    const cacheRaw = await writeProjcache(f.projcacheDir, GHOST);
    const reverter = f.make();
    await reverter.backup(GHOST, { location: { path: source } });
    await unlink(source);

    const out = await reverter.revert(GHOST);
    assert.deepEqual(out.reverted, [GHOST]);
    assert.deepEqual(out.restored, [GHOST]);
    assert.equal(out.details[0].restoredFrom, 'archive-backup');
    assert.equal(out.details[0].resumable, true);
    assert.equal(out.details[0].bytes, raw.length);
    assert.equal(out.details[0].events, 6);

    const target = sessionLogPath(f.sessionsRoot, CWD, GHOST);
    assert.deepEqual(await readFile(target), raw);
    assert.deepEqual(await readFile(join(f.projcacheDir, GHOST + '.json')), cacheRaw);
    assert.deepEqual(f.calls.unarchive, [GHOST]);

    const added = f.calls.emit.find(([name]) => name === 'api-session/added')?.[1];
    assert.equal(added?.sessionId, GHOST);
    assert.equal(added?.cwd, CWD);
    assert.equal(added?.blank, false);
    assert.equal(added?.projections?.values?.title, '视频闪退与站源订阅续');

    const upsert = f.calls.frames.find((frame) => frame.type === 'upsert');
    assert.ok(upsert?.workspace?.sessionIds?.includes(GHOST));

    const audit = f.calls.audit.at(-1);
    assert.equal(audit.action, 'unarchived');
    assert.equal(audit.restoredFrom, 'archive-backup');
    assert.equal(audit.resumable, true);
    assert.equal(audit.bytes, raw.length);

    await rm(f.root, { recursive: true, force: true });
});

test('工作区槽位已被剪掉：还原时必须 attachSession 把会话放回原工作区', async () => {
    const f = await fixture({ workspaces: [{ workspaceId: WID, path: CWD, title: 'AHVideo', sessionIds: [OTHER] }] });
    const raw = zstd(logLines(GHOST, 2));
    const source = await writeLog(f.sessionsRoot, CWD, GHOST, raw);
    const reverter = f.make();
    await reverter.backup(GHOST, { location: { path: source } });
    await unlink(source);

    const out = await reverter.revert(GHOST);
    assert.equal(out.details[0].attached, true);
    assert.deepEqual(f.calls.attach, [GHOST]);
    assert.ok(f.registry.get(WID).record.sessionIds.includes(GHOST));
    assert.deepEqual(f.calls.remember, [[GHOST, CWD]]);

    await rm(f.root, { recursive: true, force: true });
});

test('已有相同日志：识别为 existing-backup，不覆盖任何字节', async () => {
    const f = await fixture();
    const raw = zstd(logLines(GHOST, 1));
    const source = await writeLog(f.sessionsRoot, CWD, GHOST, raw);
    const reverter = f.make();
    await reverter.backup(GHOST, { location: { path: source } });

    const out = await reverter.revert(GHOST);
    assert.equal(out.details[0].restoredFrom, 'existing-backup');
    assert.equal(out.details[0].resumable, true);
    assert.deepEqual(await readFile(source), raw);
    assert.deepEqual(f.calls.unarchive, [GHOST]);

    await rm(f.root, { recursive: true, force: true });
});

test('没有完整备份：绝不写空壳，保持归档并明确报告不可恢复', async () => {
    const f = await fixture({ archived: [GHOST] });
    const reverter = f.make();

    const out = await reverter.revert(GHOST);
    assert.deepEqual(out.restored, []);
    assert.deepEqual(out.reverted, []);
    assert.equal(out.details[0].restoredFrom, 'none');
    assert.equal(out.details[0].resumable, false);
    assert.equal(out.details[0].reason, 'unrecoverable-backup');
    assert.equal(out.warnings[0].reason, 'unrecoverable-backup');
    assert.deepEqual(f.calls.unarchive, []);
    assert.deepEqual(f.calls.attach, []);
    assert.equal(existsSync(sessionLogPath(f.sessionsRoot, CWD, GHOST)), false);
    assert.equal(f.calls.emit.length, 0);
    assert.equal(f.calls.audit.at(-1).action, 'restore-failed');

    await rm(f.root, { recursive: true, force: true });
});

test('目标位置已有真实对话：restore-conflict，不覆盖用户后来写的数据', async () => {
    const f = await fixture();
    const raw = zstd(logLines(GHOST, 2));
    const source = await writeLog(f.sessionsRoot, CWD, GHOST, raw);
    const reverter = f.make();
    await reverter.backup(GHOST, { location: { path: source } });

    const later = zstd([
        ...logLines(GHOST, 1),
        {
            type: 'user/message', seq: 99, time: 1793029999999,
            data: { message: { role: 'user', content: [{ type: 'text', text: '用户后来写的新内容' }] } },
        },
    ]);
    await writeFile(source, later);

    const out = await reverter.revert(GHOST);
    assert.equal(out.details[0].restoredFrom, 'none');
    assert.equal(out.details[0].resumable, false);
    assert.equal(out.details[0].reason, 'restore-conflict');
    assert.deepEqual(f.calls.unarchive, []);
    assert.deepEqual(await readFile(source), later);
    assert.equal(f.calls.audit.at(-1).action, 'restore-failed');

    await rm(f.root, { recursive: true, force: true });
});

test('目标位置是旧版空壳：允许替换，但必须先留档', async () => {
    const f = await fixture();
    const raw = zstd(logLines(GHOST, 3));
    const source = await writeLog(f.sessionsRoot, CWD, GHOST, raw);
    const reverter = f.make();
    await reverter.backup(GHOST, { location: { path: source } });

    const shell = zstd(emptyShellLines(GHOST));
    await writeFile(source, shell);

    const out = await reverter.revert(GHOST);
    assert.equal(out.details[0].restoredFrom, 'archive-backup');
    assert.deepEqual(await readFile(source), raw);
    const kept = readdirSync(dirname(source)).filter((name) => name.includes('.pre-restore-'));
    assert.equal(kept.length, 1);
    assert.deepEqual(readFileSync(join(dirname(source), kept[0])), shell);

    await rm(f.root, { recursive: true, force: true });
});

test('整批撤销跨重启可用：last-archive.json 落盘后新实例仍能还原', async () => {
    const f = await fixture();
    const rawGhost = zstd(logLines(GHOST, 2));
    const rawOther = zstd(logLines(OTHER, 2));
    const ghostSource = await writeLog(f.sessionsRoot, CWD, GHOST, rawGhost);
    const otherSource = await writeLog(f.sessionsRoot, CWD, OTHER, rawOther);
    const reverter = f.make();
    await reverter.backup(GHOST, { location: { path: ghostSource } });
    await reverter.backup(OTHER, { location: { path: otherSource } });
    await reverter.recordBatch('2026-11-15T06:00:00.000Z', [GHOST, OTHER]);
    await unlink(ghostSource);
    await unlink(otherSource);

    const restarted = f.make();
    const out = await restarted.revert(undefined);
    assert.equal(out.at, '2026-11-15T06:00:00.000Z');
    assert.deepEqual(out.restored.sort(), [GHOST, OTHER].sort());
    assert.deepEqual(await readFile(ghostSource), rawGhost);
    assert.deepEqual(await readFile(otherSource), rawOther);
    assert.deepEqual(f.calls.unarchive.sort(), [GHOST, OTHER].sort());

    await rm(f.root, { recursive: true, force: true });
});

test('last-archive.json 缺失时从 audit.log 兜底重建整批', async () => {
    const f = await fixture();
    const rawGhost = zstd(logLines(GHOST, 1));
    const rawOther = zstd(logLines(OTHER, 1));
    const ghostSource = await writeLog(f.sessionsRoot, CWD, GHOST, rawGhost);
    const otherSource = await writeLog(f.sessionsRoot, CWD, OTHER, rawOther);
    const reverter = f.make();
    await reverter.backup(GHOST, { location: { path: ghostSource } });
    await reverter.backup(OTHER, { location: { path: otherSource } });
    await writeFile(join(f.storeDir, 'audit.log'), [
        JSON.stringify({ at: '2026-11-15T06:00:00.000Z', sessionId: GHOST, action: 'archived' }),
        JSON.stringify({ at: '2026-11-15T06:00:01.000Z', sessionId: OTHER, action: 'archived' }),
    ].join('\n') + '\n', 'utf8');
    await unlink(ghostSource);
    await unlink(otherSource);

    const out = await f.make().revert(undefined);
    // 倒数扫描以最新一条 archived 为锚点（同批 5 分钟窗口内）。
    assert.equal(out.at, '2026-11-15T06:00:01.000Z');
    assert.deepEqual(out.restored.sort(), [GHOST, OTHER].sort());
    assert.deepEqual(await readFile(ghostSource), rawGhost);
    assert.deepEqual(await readFile(otherSource), rawOther);

    await rm(f.root, { recursive: true, force: true });
});

test('重复撤销：第二次不重复 unarchive，备份仍逐字节一致', async () => {
    const f = await fixture();
    const raw = zstd(logLines(GHOST, 2));
    const source = await writeLog(f.sessionsRoot, CWD, GHOST, raw);
    const reverter = f.make();
    await reverter.backup(GHOST, { location: { path: source } });
    await reverter.revert(GHOST);
    const second = await reverter.revert(GHOST);
    assert.equal(second.details[0].alreadyUnarchived, true);
    assert.equal(second.details[0].restoredFrom, 'existing-backup');
    assert.equal(second.details[0].resumable, true);
    assert.deepEqual(await readFile(source), raw);
    assert.deepEqual(f.calls.unarchive, [GHOST]);

    await rm(f.root, { recursive: true, force: true });
});

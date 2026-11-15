import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function renderCardFromClient(historyValue) {
    const clientCode = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    let factory;
    let stateIndex = 0;
    const states = [
        { enabled: true, dryRun: false, idleDays: 7, intervalHours: 12, excludeCwdSubstrings: [], keepPinned: true, includeSubagents: false, autoUnarchive: true },
        undefined, null, '', '', '', true, null, false, '', historyValue, false,
    ];
    const React = {
        createElement(type, props, ...children) {
            if (typeof type === 'function') return type(props || {});
            return { type, props, children };
        },
        useState(initial) {
            const i = stateIndex++;
            return [states[i] !== undefined ? states[i] : (typeof initial === 'function' ? initial() : initial), () => {}];
        },
        useEffect() {}, useCallback(fn) { return fn; }, useRef(v) { return { current: v }; },
    };
    const sandbox = {
        window: { __ModuleLoader__: { load: (record) => { factory = record.factory; } } },
        console, navigator: { language: 'zh' },
        globalThis: { localStorage: { getItem: () => null, setItem() {} }, location: { reload() {} }, setTimeout },
        setTimeout, JSON, Date, Object, Array, String, Number, Boolean, Math, Promise, Map, Set, Error, TypeError,
    };
    vm.createContext(sandbox);
    vm.runInContext(clientCode, sandbox);
    const client = factory((name) => (name === 'react' ? React : {}));
    let card;
    const slots = {
        entries: (key) => (key === 'settings.section' ? [{ options: { id: 'plugin-settings' } }] : []),
        inject: (key, callback) => { callback(); return () => {}; },
        register: (options, component) => { if (options.name === 'plugin-settings.item') card = component; return () => {}; },
    };
    client.apply({ slots });
    stateIndex = 0;
    return card();
}

test('设置卡片首屏渲染：history 尚未加载(null)时不得抛 TypeError', () => {
    assert.doesNotThrow(() => renderCardFromClient(null));
    assert.doesNotThrow(() => renderCardFromClient([]));
    assert.doesNotThrow(() => renderCardFromClient([{ action: 'archived', sessionId: 's1', at: '2026-11-07T12:02:51.229Z', title: 'x' }]));
});

test('设置卡片能渲染不可恢复与已还原的审计行', () => {
    assert.doesNotThrow(() => renderCardFromClient([
        { action: 'restore-failed', sessionId: 's1', at: '2026-11-07T12:02:51.229Z', error: 'missing backup' },
        { action: 'unarchived', sessionId: 's2', at: '2026-11-07T12:03:51.229Z', restoredFrom: 'archive-backup' },
    ]));
});

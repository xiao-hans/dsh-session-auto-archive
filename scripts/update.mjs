#!/usr/bin/env node
/**
 * dsh-session-auto-archive 安装/更新脚本（多机通用，零依赖）。
 *
 *   node <profile>/dsh-session-auto-archive/scripts/update.mjs --register
 *       首次安装：把插件写进 profile 的 dependencies 与 dsh.profile.bundles（幂等）。
 *   node <profile>/dsh-session-auto-archive/scripts/update.mjs --check
 *       只看有没有新版本，不动盘；有新版时退出码为 10。
 *   node <profile>/dsh-session-auto-archive/scripts/update.mjs
 *       更新：git pull --ff-only，依赖有变化时自动 pnpm install。
 *
 * 脚本假定自己躺在 profile 目录下的插件目录里（profile 目录 = 上一级），因此
 * desktop / web 两个 profile、任何机器都不用改路径。npm 包安装（无 .git）时
 * --register 依旧可用，pull 相关分支自动跳过。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = dirname(PLUGIN_DIR);
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const REGISTER = args.includes('--register');
const NO_INSTALL = args.includes('--no-install');

const die = (msg) => { console.error(`\n!! ${msg}\n`); process.exit(1); };
const runGit = (a) => spawnSync('git', a, { cwd: PLUGIN_DIR, encoding: 'utf8', shell: process.platform === 'win32' });
const git = (a) => {
    const r = runGit(a);
    if (r.status !== 0) die(`git ${a.join(' ')} 失败：${(r.stderr || r.stdout || '').trim()}`);
    return (r.stdout || '').trim();
};
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };

const pkg = readJson(resolve(PLUGIN_DIR, 'package.json')) ?? die('读不到本插件的 package.json');
const NAME = pkg.name;
const LOCAL_VERSION = pkg.version;
const PROFILE_PKG_PATH = resolve(PROFILE_DIR, 'package.json');

console.log(`\n${NAME}`);
console.log(`  插件目录  ${PLUGIN_DIR}`);
console.log(`  profile   ${PROFILE_DIR}`);
console.log(`  本地版本  v${LOCAL_VERSION}\n`);

// ---- --register：写 profile 的 dependencies + bundles。不需要 git，npm 安装也能用。----
if (REGISTER) {
    const profilePkg = readJson(PROFILE_PKG_PATH) ?? die(`读不到 ${PROFILE_PKG_PATH}`);
    profilePkg.dependencies ??= {};
    profilePkg.dsh ??= {};
    profilePkg.dsh.profile ??= {};
    const bundles = (profilePkg.dsh.profile.bundles ??= []);
    const wantDep = `file:./${basename(PLUGIN_DIR)}`;
    const changes = [];
    if (profilePkg.dependencies[NAME] === undefined) {
        profilePkg.dependencies[NAME] = wantDep;
        changes.push(`+ dependencies["${NAME}"] = "${wantDep}"`);
    } else if (profilePkg.dependencies[NAME] !== wantDep) {
        changes.push(`~ dependencies["${NAME}"] 已是 "${profilePkg.dependencies[NAME]}"（非 file: 引用，不覆盖，请自行确认）`);
    }
    if (!bundles.includes(NAME)) {
        bundles.push(NAME);
        changes.push(`+ dsh.profile.bundles 追加 "${NAME}"`);
    }
    if (!changes.length) { console.log('  已注册，profile 无需改动。\n'); process.exit(0); }
    console.log('  写入 profile/package.json：');
    changes.forEach((c) => console.log(`    ${c}`));
    const before = readFileSync(PROFILE_PKG_PATH, 'utf8');
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const after = JSON.stringify(profilePkg, null, 2) + (before.endsWith('\n') ? '\n' : '');
    writeFileSync(PROFILE_PKG_PATH, eol === '\r\n' ? after.replace(/\n/g, '\r\n') : after);
    console.log(`  已写入 ${PROFILE_PKG_PATH}`);
    console.log('  接着在该 profile 目录执行 pnpm install，然后重启 DSH。\n');
    process.exit(0);
}

// ---- 非 git 安装（npm 包）：没有可 pull 的东西，直接说明更新方式并退出 ----
if (!existsSync(resolve(PLUGIN_DIR, '.git'))) {
    console.log('  这个目录不是 git 克隆（应是从 npm 包安装的）。无法自动 pull。');
    console.log('  更新：在 profile 目录重新安装新版本包，或改用 git clone + --register。\n');
    process.exit(0);
}
if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') die('当前目录不在 git 工作树内');

// ---- --check：只读，本地有未提交改动也能跑 ----
if (CHECK) {
    git(['fetch', '--quiet', 'origin']);
    const counts = git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).split(/\s+/);
    const behind = Number(counts[1] ?? 0);
    let remoteVersion = '?';
    try { remoteVersion = JSON.parse(git(['show', '@{upstream}:package.json'])).version; } catch { /* 无 upstream */ }
    console.log(`  远端版本  v${remoteVersion}   落后 ${behind} 个提交`);
    console.log(behind > 0 ? '\n  有新版本：去掉 --check 运行本脚本即可更新。\n' : '\n  已是最新。\n');
    process.exit(behind > 0 ? 10 : 0);
}

// ---- 更新：本地有改动时拒绝 pull，防止覆盖手工补丁 ----
const dirty = git(['status', '--porcelain', '--', 'lib', 'package.json', 'README.md', 'scripts']);
if (dirty) {
    console.log('  本地源码有未提交改动：');
    dirty.split('\n').forEach((l) => console.log(`    ${l}`));
    die('先把改动提交并推上去（或 git stash），再更新。直接 pull 会冲突或覆盖。');
}

const beforeDeps = JSON.stringify([pkg.dependencies ?? {}, pkg.devDependencies ?? {}]);
const headSha = git(['rev-parse', 'HEAD']);

console.log('  git pull --ff-only ...');
const pull = runGit(['pull', '--ff-only']);
process.stdout.write(pull.stdout || '');
process.stderr.write(pull.stderr || '');
if (pull.status !== 0) die('pull 失败（见上）。按提示处理后重试。');

const afterPkg = readJson(resolve(PLUGIN_DIR, 'package.json')) ?? {};
const afterVersion = afterPkg.version ?? '?';
let changedFiles = [];
try { changedFiles = git(['diff', '--name-only', `${headSha}..HEAD`]).split('\n').filter(Boolean); } catch { /* 浅克隆等 */ }
const depsChanged = JSON.stringify([afterPkg.dependencies ?? {}, afterPkg.devDependencies ?? {}]) !== beforeDeps;
const needsInstall = depsChanged || changedFiles.includes('pnpm-lock.yaml');

console.log(`\n  版本  v${LOCAL_VERSION} → v${afterVersion}`);
if (changedFiles.length) console.log(`  本次更新涉及 ${changedFiles.length} 个文件`);

if (needsInstall && !NO_INSTALL) {
    console.log('  依赖有变化 → pnpm install ...');
    const ins = spawnSync('pnpm', ['install'], { cwd: PROFILE_DIR, encoding: 'utf8', shell: process.platform === 'win32' });
    process.stdout.write(ins.stdout || '');
    process.stderr.write(ins.stderr || '');
    if (ins.status !== 0) die('pnpm install 失败（见上）');
} else if (!needsInstall) {
    console.log('  依赖未变，跳过 pnpm install。');
}

console.log(`
更新完成。下一步（必须，否则宿主还在跑旧代码）：
  1) 完全退出 DSH 再启动（或：设置 → 插件 → 禁用本插件 → 启用）。
  2) 自证版本已生效：打开 http://127.0.0.1:<DSH 端口>/api/dsh-auto-archive/status
     看返回里的 "version"；或看设置卡片标题右侧的 v${afterVersion} 徽章。
`);

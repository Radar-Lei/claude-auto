import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { QuotaMonitor, parseQuotaResponse, poolAvailability, accountAvailability, formatPool, gatewayStopReason } from '../glm-quota.js';
import type { QuotaSnapshot, PoolSnapshot, AccountQuota } from '../glm-quota.js';

const now = Date.now();
const hour = 3600e3;
const fiveHour = (percentage = 100, nextResetTime = now + hour) => ({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime });
const weekly = (percentage = 100, nextResetTime = now + 72 * hour) => ({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage, nextResetTime });
const monthly = { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 100, usage: 4000, currentValue: 4000 };
const response = (limits: unknown[]) => ({ code: 200, data: { limits } });
const quota = (limits: unknown[]): QuotaSnapshot => parseQuotaResponse(response(limits), now)!;
const account = (id: string, limits: unknown[]): AccountQuota => ({ id, name: id, quota: quota(limits), stale: false, error: null });
const pool = (...accounts: AccountQuota[]): PoolSnapshot => ({ accounts, fetchedAt: now, configError: null, source: 'accounts' });

test('周期字段区分周、五小时及 MCP，返回顺序不影响结果', () => {
    for (const rows of [[weekly(81), monthly, fiveHour(22)], [fiveHour(22), weekly(81), monthly]]) {
        const result = quota(rows);
        assert.equal(result.tokens?.percentage, 22);
        assert.equal(result.weekly?.percentage, 81);
        assert.equal(result.monthly?.percentage, 100);
    }
    const legacy = quota([{ type: 'TOKENS_LIMIT', percentage: 44 }, monthly]);
    assert.equal(legacy.tokens?.percentage, 44);
    assert.equal(legacy.weekly, null);
    assert.match(formatPool(pool({ id: 'v1', name: 'V1', quota: legacy, stale: false, error: null })), /周额度 : 未提供/);
    assert.equal(parseQuotaResponse({ code: 200, data: { limits: [null, 'bad'] } }), null);
});

test('账号内取较晚重置，账号之间取较早恢复；MCP 不阻止模型', () => {
    const a = account('a', [fiveHour(100, now + hour), weekly(100, now + 72 * hour)]);
    const b = account('b', [fiveHour(100, now + 2 * hour), weekly(70), monthly]);
    assert.deepEqual(accountAvailability(a, now), { state: 'blocked', resetAt: now + 72 * hour });
    assert.deepEqual(poolAvailability(pool(a, b), now), { state: 'blocked', resetAt: now + 2 * hour });
    assert.equal(poolAvailability(pool(a, b, account('c', [fiveHour(25), monthly])), now).state, 'ready');
    assert.equal(accountAvailability(account('v1', [fiveHour(99), monthly]), now).state, 'ready');
});

test('失败、旧数据和缺失重置时间不能支撑整个账号池的长倒计时', () => {
    const full = account('full', [fiveHour(), weekly()]);
    const unknown = { ...account('unknown', [fiveHour(20)]), stale: true, error: 'HTTP 500' };
    assert.deepEqual(poolAvailability(pool(full, unknown), now), { state: 'unknown', resetAt: null });
    assert.equal(poolAvailability(pool(full, { ...unknown, stale: false, error: null }), now).state, 'ready');
    const noTime = account('no-time', [{ ...fiveHour(), nextResetTime: null }, weekly()]);
    assert.deepEqual(poolAvailability(pool(full, noTime), now), { state: 'blocked', resetAt: null });
    assert.equal(accountAvailability(account('past', [fiveHour(100, now - 1000)]), now).resetAt, null);
    assert.equal(accountAvailability(account('weekly-still-blocked', [fiveHour(100, now - 1000), weekly()]), now).resetAt, now + 72 * hour);
    assert.equal(poolAvailability(pool(), now).state, 'unknown');
});

test('明确的网关故障停止重试，上游额度与网络错误保留恢复流程', () => {
    for (const error of ['Invalid API key', 'authentication_error', 'Insufficient balance', 'API key quota exceeded', '余额不足']) {
        assert.notEqual(gatewayStopReason(error), null);
    }
    for (const error of ['[1308]已达到每周使用上限', 'Connection closed mid-response', '529 overloaded', 'usage limit reached']) {
        assert.equal(gatewayStopReason(error), null);
    }
});

test('查询、缓存、增减账号、套餐升级及失败恢复共享同一个公开接口', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-quota-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const requests: string[] = [];
    let fail = false;
    let upgraded = false;
    const server = createServer((req, res) => {
        requests.push(req.headers.authorization ?? '');
        res.setHeader('Content-Type', 'application/json');
        if (fail && req.headers.authorization === 'official-b') {
            res.writeHead(500).end('no');
            return;
        }
        res.end(JSON.stringify(response(upgraded ? [weekly(35), fiveHour(10), monthly] : [fiveHour(100), monthly])));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const file = path.join(dir, 'accounts.json');
    const rows = ['a', 'b'].map(id => ({ id, name: id, apiKey: `official-${id}`, quotaUrl: `http://127.0.0.1:${port}/quota` }));
    const save = () => fs.writeFileSync(file, JSON.stringify({ accounts: rows }));
    save();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'relay-secret' } }));
    const options = { configDir: dir, accountsFile: file, env: {} };
    const monitor = new QuotaMonitor(options);
    assert.equal(monitor.redact('official-a relay-secret'), '<密钥已隐藏> <密钥已隐藏>');
    const first = await monitor.read();
    assert.deepEqual(requests.sort(), ['official-a', 'official-b']);
    assert.equal(first.accounts.length, 2);
    await new QuotaMonitor(options).read(true);
    assert.equal(requests.length, 2, '独立进程可复用缓存');
    fail = true;
    const failed = await monitor.read();
    assert.equal(failed.accounts[1]?.stale, true);
    assert.equal(poolAvailability(failed).state, 'unknown');
    assert.match(formatPool(failed, true), /上次数据/);
    fail = false;
    upgraded = true;
    assert.equal((await monitor.read()).accounts[0]?.quota?.weekly?.percentage, 35);
    rows.push({ id: 'c', name: 'c', apiKey: 'official-c', quotaUrl: rows[0]!.quotaUrl });
    save();
    assert.equal((await monitor.read(true)).accounts.length, 3, '列表修改使缓存失效');
    rows.splice(0, 1);
    save();
    assert.deepEqual((await monitor.read()).accounts.map(a => a.id), ['b', 'c']);
    assert.doesNotMatch(monitor.redact('official-a official-c relay-secret'), /official-[ac]|relay-secret/);
    const cache = fs.readFileSync(path.join(dir, 'glm-quota-cache.json'), 'utf8');
    assert.doesNotMatch(cache, /official-[abc]|relay-secret|apiKey|quotaUrl/);
    assert.doesNotMatch(JSON.stringify(first), /official-[ab]|relay-secret/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'glm-quota-cache.json')).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{ broken config with a secret');
    const broken = await monitor.read(true);
    assert.equal(poolAvailability(broken).state, 'unknown');
    assert.ok(broken.configError);
    assert.doesNotMatch(JSON.stringify(broken), /secret/);
});

test('中转站未配置账号时给出提示，不将中转站密钥发送给官方', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-relay-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'relay-secret' } }));
    const result = await new QuotaMonitor({ configDir: dir, env: {} }).read();
    assert.equal(result.accounts.length, 0);
    assert.match(result.configError!, /glm-accounts.json/);
    assert.doesNotMatch(JSON.stringify(result), /relay-secret/);
    const override = await new QuotaMonitor({ configDir: dir, env: { GLM_QUOTA_URL: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit' } }).read();
    assert.equal(override.accounts.length, 0, '自定义额度地址也不能把中转站凭据当成官方凭据');
});

const entry = fileURLToPath(new URL('../claude-glm-auto.ts', import.meta.url));
const loader = fileURLToPath(import.meta.resolve('tsx'));
function cli(args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', loader, entry, ...args], { env, stdio: 'pipe' });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
    });
}

test('状态栏安装跨目录可运行、保留设置和备份；查询命令不启动 Claude', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-install-'));
    const dir = path.join(root, 'profile with spaces');
    fs.mkdirSync(dir);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const settingsFile = path.join(dir, 'settings.json');
    const original = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'relay-secret' }, theme: 'dark', statusLine: { type: 'command', command: 'old-command' } });
    fs.writeFileSync(settingsFile, original);
    const env = { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', GLM_QUOTA_URL: '', CLAUDE_CONFIG_DIR: '' };
    const args = ['--auto-config-dir', dir, '--install-statusline'];
    assert.equal((await cli(args, env)).code, 0);
    const installed = fs.readFileSync(settingsFile, 'utf8');
    assert.equal((await cli(args, env)).code, 0);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), installed);
    assert.equal(fs.readFileSync(settingsFile + '.before-glm-statusline', 'utf8'), original);
    const settings = JSON.parse(installed);
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'relay-secret');
    assert.doesNotMatch(settings.statusLine.command, /relay-secret/);
    const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(settings.statusLine.command, { shell: true, cwd: root, env });
        let out = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`statusline exited ${code}`)));
        child.stdin.end('{}');
    });
    assert.match(output, /glm-accounts.json/);
    const json = await cli(['--auto-config-dir', dir, '--glm-quota', '--json'], env);
    assert.equal(json.code, 1);
    assert.ok(JSON.parse(json.stdout).configError);
    assert.equal(json.stderr, '');
});

test('终端调试日志隐藏屏幕中出现的已知密钥，临时错误仍可续跑', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-debug-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: {
        ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'relay-secret',
    } }));
    const bin = fileURLToPath(new URL('./bin', import.meta.url));
    const child = spawn(process.execPath, ['--import', loader, entry, '--auto-config-dir', dir, '--auto-debug'], {
        cwd: dir, stdio: 'pipe', env: {
            ...process.env, PATH: bin + path.delimiter + process.env.PATH,
            ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', CGA_TIME_SCALE: '0.01',
            FAKE_BANNER: '● API Error: Connection closed mid-response relay-secret', FAKE_NEXT: '-',
        },
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const result = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('终端未按预期恢复')); }, 5000);
        child.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('❯ continue')) child.kill('SIGTERM');
        });
        child.on('error', reject);
        child.on('close', () => { clearTimeout(timeout); resolve(output); });
    });
    assert.match(result, /❯ continue/);
    const log = fs.readFileSync(path.join(dir, 'claude-glm-auto.log'), 'utf8');
    assert.match(log, /<密钥已隐藏>/);
    assert.doesNotMatch(log, /relay-secret/);
    assert.match(log, /Sending "continue" \(transient\)/);
});

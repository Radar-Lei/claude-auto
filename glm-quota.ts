import * as fs from 'node:fs';
import * as path from 'node:path';

export const QUOTA_PATH = '/api/monitor/usage/quota/limit';
export const DEFAULT_QUOTA_URL = `https://open.bigmodel.cn${QUOTA_PATH}`;
export const CACHE_TTL_MS = 5 * 60 * 1000;

export interface QuotaWindow {
    percentage: number;
    nextResetTime: number | null;
    currentUsage: number | null;
    capacity: number | null;
}

export interface QuotaSnapshot {
    tokens: QuotaWindow | null;
    weekly: QuotaWindow | null;
    monthly: QuotaWindow | null;
    fetchedAt: number;
}

export interface AccountQuota {
    id: string;
    name: string;
    quota: QuotaSnapshot | null;
    stale: boolean;
    error: string | null;
}

export interface PoolSnapshot {
    source: 'accounts' | 'direct';
    accounts: AccountQuota[];
    fetchedAt: number;
    configError: string | null;
}

interface Account {
    id: string;
    name: string;
    apiKey: string;
    quotaUrl: string;
}

interface Configuration {
    source: PoolSnapshot['source'];
    accounts: Account[];
    stamp: string | null;
    error: string | null;
}

export interface MonitorOptions {
    configDir: string;
    accountsFile?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    cacheTtlMs?: number;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseWindow(entry: Record<string, unknown>, now: number): QuotaWindow | null {
    const percentage = numberOrNull(entry.percentage);
    if (percentage === null || percentage < 0) return null;
    const stamp = numberOrNull(entry.nextResetTime);
    return {
        percentage,
        nextResetTime: stamp !== null && stamp > now - 3600e3 && stamp < now + 35 * 86400e3
            ? stamp : null,
        currentUsage: numberOrNull(entry.currentValue),
        capacity: numberOrNull(entry.usage),
    };
}

/** 周窗口和五小时窗口同为 TOKENS_LIMIT，必须用周期字段区分。 */
export function parseQuotaResponse(body: unknown, now = Date.now()): QuotaSnapshot | null {
    if (!body || typeof body !== 'object') return null;
    const { code, data } = body as { code?: unknown; data?: { limits?: unknown } };
    if (code !== 200 || !data || !Array.isArray(data.limits)) return null;
    const snapshot: QuotaSnapshot = { tokens: null, weekly: null, monthly: null, fetchedAt: now };
    for (const entry of data.limits) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const window = parseWindow(row, now);
        if (row.type === 'TIME_LIMIT') snapshot.monthly = window;
        if (row.type !== 'TOKENS_LIMIT' && row.type !== 'CREDIT_LIMIT') continue;
        if (row.unit === 6 && row.number === 1) snapshot.weekly = window;
        // 老接口的单一 TOKENS_LIMIT 没有周期字段。
        if ((row.unit === 3 && row.number === 5) || (row.unit === undefined && row.number === undefined)) {
            snapshot.tokens = window;
        }
    }
    return snapshot.tokens || snapshot.weekly || snapshot.monthly ? snapshot : null;
}

export type Availability = { state: 'ready' | 'blocked' | 'unknown'; resetAt: number | null };

export function accountAvailability(account: AccountQuota, now = Date.now()): Availability {
    if (account.stale || !account.quota) return { state: 'unknown', resetAt: null };
    const { tokens, weekly } = account.quota;
    const exhausted = [tokens, weekly].filter((w): w is QuotaWindow => w !== null && w.percentage >= 100);
    if (exhausted.length === 0) return { state: tokens ? 'ready' : 'unknown', resetAt: null };
    // 一个窗口明确触顶即可确认受限；缺失的重置时间不能用其他窗口代替。
    const times = exhausted.map(w => w.nextResetTime);
    const latest = tokens && times.every((t): t is number => t !== null) ? Math.max(...times as number[]) : null;
    const resetAt = latest !== null && latest > now ? latest : null;
    return { state: 'blocked', resetAt };
}

export function poolAvailability(pool: PoolSnapshot, now = Date.now()): Availability {
    if (pool.configError || pool.accounts.length === 0) return { state: 'unknown', resetAt: null };
    const states = pool.accounts.map(a => accountAvailability(a, now));
    if (states.some(s => s.state === 'ready')) return { state: 'ready', resetAt: null };
    if (states.some(s => s.state === 'unknown')) return { state: 'unknown', resetAt: null };
    return {
        state: 'blocked',
        resetAt: states.every(s => s.resetAt !== null) ? Math.min(...states.map(s => s.resetAt!)) : null,
    };
}

function readConfiguration(options: MonitorOptions): Configuration {
    const env = options.env ?? process.env;
    const filename = options.accountsFile ?? path.join(options.configDir, 'glm-accounts.json');
    const failed = (error: string): Configuration => ({ source: 'accounts', accounts: [], stamp: null, error });
    if (options.accountsFile || fs.existsSync(filename)) {
        try {
            const body = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!Array.isArray(body.accounts) || body.accounts.length === 0) {
                return failed('账号配置的 accounts 必须是非空数组');
            }
            const ids = new Set<string>();
            const accounts: Account[] = [];
            for (const row of body.accounts) {
                if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)
                    || typeof row.name !== 'string' || !row.name.trim()
                    || typeof row.apiKey !== 'string' || !row.apiKey.trim()
                    || (row.quotaUrl !== undefined && typeof row.quotaUrl !== 'string')) {
                    return failed('每个账号需要唯一 id、name、apiKey，以及可选的 quotaUrl');
                }
                const quotaUrl = env.GLM_QUOTA_URL ?? row.quotaUrl ?? DEFAULT_QUOTA_URL;
                if (!['http:', 'https:'].includes(new URL(quotaUrl).protocol)) return failed('额度接口需要 HTTP(S) 地址');
                ids.add(row.id);
                accounts.push({ id: row.id, name: row.name, apiKey: row.apiKey, quotaUrl });
            }
            return { source: 'accounts', accounts, stamp: `${filename}:${fs.statSync(filename).mtimeMs}`, error: null };
        } catch {
            return failed('无法读取账号配置，请检查 glm-accounts.json 或 --auto-accounts-file');
        }
    }

    // 直连模式继续读取完整的凭据对；中转站密钥不能用于查询官方账号。
    let baseUrl = env.ANTHROPIC_BASE_URL;
    let apiKey = env.ANTHROPIC_AUTH_TOKEN;
    let stamp: string | null = null;
    if (!baseUrl || !apiKey) {
        try {
            const settingsFile = path.join(options.configDir, 'settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            baseUrl = settings.env?.ANTHROPIC_BASE_URL;
            apiKey = settings.env?.ANTHROPIC_AUTH_TOKEN;
            stamp = `${settingsFile}:${fs.statSync(settingsFile).mtimeMs}`;
        } catch { /* 由下方返回可操作的配置提示。 */ }
    }
    try {
        if (baseUrl && apiKey) {
            const url = new URL(baseUrl);
            if (['open.bigmodel.cn', 'api.z.ai'].includes(url.hostname)) {
                return {
                    source: 'direct', stamp, error: null,
                    accounts: [{ id: 'direct', name: 'GLM', apiKey, quotaUrl: env.GLM_QUOTA_URL ?? url.origin + QUOTA_PATH }],
                };
            }
        }
    } catch { /* 不把解析错误（可能含凭据）写入输出。 */ }
    return failed('请在 Claude 配置目录创建 glm-accounts.json，填写用于查询额度的官方 GLM 账号密钥');
}

/** 查询、缓存及失败状态在一个模块内共享，调用方始终拿不到账号密钥。 */
export class QuotaMonitor {
    private inflight: Promise<PoolSnapshot> | null = null;
    private readonly cacheFile: string;
    private readonly secrets = new Set<string>();

    constructor(private readonly options: MonitorOptions) {
        this.cacheFile = path.join(options.configDir, 'glm-quota-cache.json');
        this.rememberSecrets(readConfiguration(options));
    }

    /** 调试屏幕可能包含用户编辑密钥的内容，统一在日志出口隐藏已知密钥。 */
    redact(message: string): string {
        for (const secret of this.secrets) message = message.split(secret).join('<密钥已隐藏>');
        return message;
    }

    private rememberSecrets(config: Configuration): void {
        for (const account of config.accounts) this.secrets.add(account.apiKey);
        const token = (this.options.env ?? process.env).ANTHROPIC_AUTH_TOKEN;
        if (token) this.secrets.add(token);
        try {
            const settings = JSON.parse(fs.readFileSync(path.join(this.options.configDir, 'settings.json'), 'utf8'));
            if (typeof settings.env?.ANTHROPIC_AUTH_TOKEN === 'string' && settings.env.ANTHROPIC_AUTH_TOKEN) {
                this.secrets.add(settings.env.ANTHROPIC_AUTH_TOKEN);
            }
        } catch { /* 环境变量或独立账号文件已足够支持查询。 */ }
    }

    async read(cached = false): Promise<PoolSnapshot> {
        if (this.inflight) return this.inflight;
        const config = readConfiguration(this.options);
        this.rememberSecrets(config);
        const previous = this.readCache(config);
        if (cached && previous && Date.now() - previous.fetchedAt < (this.options.cacheTtlMs ?? CACHE_TTL_MS)) {
            return previous;
        }
        this.inflight = this.refresh(config, previous);
        try { return await this.inflight; }
        finally { this.inflight = null; }
    }

    private readCache(config: Configuration): PoolSnapshot | null {
        if (config.stamp === null || config.error) return null;
        try {
            const cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
            if (cache.configurationStamp !== config.stamp || !Array.isArray(cache.pool?.accounts)) return null;
            if (cache.pool.accounts.length !== config.accounts.length
                || !config.accounts.every((a, i) => a.id === cache.pool.accounts[i]?.id && a.name === cache.pool.accounts[i]?.name)) return null;
            return cache.pool as PoolSnapshot;
        } catch { return null; }
    }

    private async refresh(config: Configuration, previous: PoolSnapshot | null): Promise<PoolSnapshot> {
        const accounts = await Promise.all(config.accounts.map(async (account): Promise<AccountQuota> => {
            const publicAccount = { id: account.id, name: account.name };
            let error: string;
            try {
                const response = await fetch(account.quotaUrl, {
                    headers: { authorization: account.apiKey },
                    signal: AbortSignal.timeout(this.options.timeoutMs ?? 8000),
                });
                const quota = response.ok ? parseQuotaResponse(await response.json()) : null;
                if (quota) return { ...publicAccount, quota, stale: false, error: null };
                error = response.ok ? '额度接口返回格式不正确' : `额度接口 HTTP ${response.status}`;
            } catch {
                error = '额度查询失败或超时';
            }
            const quota = previous?.accounts.find(a => a.id === account.id)?.quota ?? null;
            return { ...publicAccount, quota, stale: quota !== null, error };
        }));
        const pool: PoolSnapshot = { source: config.source, accounts, fetchedAt: Date.now(), configError: config.error };
        if (!config.error) {
            // 仅保存规范化的显示数据，不保存密钥、URL 或原始响应。
            const temporary = `${this.cacheFile}.${process.pid}.tmp`;
            try {
                fs.writeFileSync(temporary, JSON.stringify({ configurationStamp: config.stamp, pool }), { mode: 0o600 });
                fs.renameSync(temporary, this.cacheFile);
            } catch {
                try { fs.unlinkSync(temporary); } catch { /* 只读配置目录仍可正常查询。 */ }
            }
        }
        return pool;
    }
}

export function formatPool(pool: PoolSnapshot, compact = false): string {
    if (pool.configError) return `GLM 额度：${pool.configError}`;
    return pool.accounts.map(account => {
        if (!account.quota) return `${account.name}：额度未知（${account.error}）`;
        const quota = account.quota;
        const display = (window: QuotaWindow | null): string => window ? `${Math.round(window.percentage)}%` : '未提供';
        const stale = account.stale ? '（查询失败，上次数据）' : '';
        if (compact) return `${account.name} 5h ${display(quota.tokens)}／周 ${display(quota.weekly)}${stale}`;
        const lines = [`${account.name} [${account.id}]${stale}（更新 ${new Date(quota.fetchedAt).toLocaleString()}）`];
        for (const [label, window] of [['5h token window', quota.tokens], ['周额度', quota.weekly], ['MCP monthly', quota.monthly]] as const) {
            lines.push(`  ${label} : ${display(window)}` + (window?.nextResetTime ? `，重置 ${new Date(window.nextResetTime).toLocaleString()}` : ''));
        }
        return lines.join('\n');
    }).join(compact ? ' | ' : '\n\n');
}

export function poolTitle(pool: PoolSnapshot): string {
    if (pool.configError) return 'GLM 额度未配置';
    const ready = pool.accounts.filter(a => accountAvailability(a).state === 'ready').length;
    const unknown = pool.accounts.filter(a => accountAvailability(a).state === 'unknown').length;
    return `GLM 未触顶 ${ready}/${pool.accounts.length}` + (unknown ? ` · 未知 ${unknown}` : '');
}

/** 仅明确的鉴权和中转站余额/密钥限额错误会停止自动重试。 */
export function gatewayStopReason(tail: string): string | null {
    if (/invalid[\s_]+(?:api[\s_]+key|authentication)|authentication_error|api[\s_]*key[\s\S]{0,30}(?:expired|disabled|deactivated)|无效.{0,10}(?:密钥|令牌)|(?:密钥|令牌).{0,10}(?:过期|失效)/i.test(tail)) {
        return '中转站鉴权失败，请检查密钥';
    }
    if (/insufficient[\s_]+(?:balance|quota)|balance[\s_]+(?:insufficient|exhausted)|api[\s_]*key[\s\S]{0,20}quota[\s\S]{0,20}(?:exceeded|exhausted)|余额不足|余额已用尽|密钥额度.{0,8}(?:不足|耗尽|用尽)/i.test(tail)) {
        return '中转站余额或密钥额度不足';
    }
    return null;
}

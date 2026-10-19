import * as fs from 'node:fs';
import * as path from 'node:path';

/** 生成当前机器适用的安装命令，路径全部由实际安装位置推导。 */
export function installStatusline(configDir: string, accountsFile?: string): string {
    const filename = path.join(configDir, 'settings.json');
    const original = fs.readFileSync(filename, 'utf8');
    const settings = JSON.parse(original);
    const quote = (value: string): string => process.platform === 'win32'
        ? `"${value.replace(/"/g, '""')}"`
        : `'${value.replace(/'/g, `'"'"'`)}'`;
    const command = [process.execPath, ...process.execArgv, path.resolve(process.argv[1]!),
        '--auto-config-dir', configDir, ...(accountsFile ? ['--auto-accounts-file', accountsFile] : []), '--statusline']
        .map(quote).join(' ');
    if (settings.statusLine?.command === command && settings.statusLine?.refreshInterval === 300) return filename;
    const backup = `${filename}.before-glm-statusline`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { mode: 0o600 });
    settings.statusLine = { type: 'command', command, refreshInterval: 300 };
    fs.writeFileSync(filename, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    return filename;
}

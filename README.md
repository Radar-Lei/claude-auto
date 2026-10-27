# claude-glm-auto

为使用 GLM 的 Claude Code 自动等待额度恢复、处理临时断线，并显示多个账号的五小时和周额度。

模型请求按原配置发送，可以直连智谱，也可以经过你自己的中转站。中转站负责账号优先级和切换；本工具独立查询官方账号额度，判断何时尝试继续任务。支持 macOS、Linux 和 Windows。

## 安装

需要 Node.js 18.19 或更新版本，以及已经安装、配置好的 Claude Code。项目使用 `node-pty`，安装时若没有适用的预编译文件，需要系统的原生编译工具。

```bash
git clone https://github.com/Radar-Lei/claude-auto.git
cd claude-auto
npm install
npm run build
npm link
```

也可以使用 Bun 安装依赖和构建，仓库包含 `bun.lock`：

```bash
bun install
bun run build
bun link
```

直接启动，或者安装替代 `claude` 的 shell 别名：

```bash
claude-glm-auto --auto-config-dir ~/.claude_glm
claude-glm-auto --install-alias --auto-config-dir ~/.claude_glm
```

安装别名后重新打开终端。`--uninstall-alias` 删除本工具的别名区块。额外的 Claude Code 参数照常传递：

```bash
claude-glm-auto --auto-config-dir ~/.claude_glm --permission-mode plan
```

## 配置多个账号

保留 Claude 配置目录中 `settings.json` 的中转站地址、密钥和模型设置。在同一目录增加 `glm-accounts.json`，复制仓库里的 [配置示例](glm-accounts.example.json)，填入各账号的**官方 GLM API Key**：

```json
{
  "accounts": [
    { "id": "main", "name": "主账号", "apiKey": "官方账号 A 的密钥" },
    { "id": "backup", "name": "备用账号", "apiKey": "官方账号 B 的密钥" }
  ]
}
```

- `id` 是唯一、稳定的账号标识；`name` 是状态栏中的显示名称。
- 需要第三个或更多账号时，继续向 `accounts` 数组增加项目。只填写当前中转站分组实际允许使用的账号；停用的账号从列表删除。
- 每项可以提供 `quotaUrl`，默认是 `https://open.bigmodel.cn/api/monitor/usage/quota/limit`。国际站可填写 `https://api.z.ai/api/monitor/usage/quota/limit`。
- 文件每五分钟重新读取，运行期间增减账号会在下一轮生效。套餐升级后直接采用接口返回的窗口和用量，无需填写套餐档位或升级日期。

这些官方密钥仅发送给对应额度接口；模型请求始终使用原来的 Claude Code 配置。中转站的 `/v1/usage` 是中转站自己的计费数据，不作为 GLM 官方账号额度。

实际账号文件放在个人配置目录，不上传 Git。在 macOS/Linux 上限制文件权限：

```bash
chmod 600 ~/.claude_glm/glm-accounts.json
```

使用 Windows PowerShell 时，配置目录例如 `$HOME\.claude_glm`，在资源管理器的文件权限中限制其他用户读取密钥。

多个 Claude 配置也可以共用一个账号文件：

```bash
claude-glm-auto --auto-config-dir ~/.claude_glm --auto-accounts-file ~/private/glm-accounts.json
```

### 官方直连单账号

没有账号列表时，仍支持读取一对完整的 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`：优先读取导出的环境变量，其次读取 Claude 配置目录的 `settings.json`。只有智谱官方地址会自动启用这种模式；自建中转站需要单独配置账号列表。

配置目录优先使用 `--auto-config-dir`，其次是环境变量 `CLAUDE_CONFIG_DIR`，最后是 `~/.claude`。不会混合两个来源中的半对凭据。

## 查询额度与底部状态栏

```bash
claude-glm-auto --auto-config-dir ~/.claude_glm --glm-quota
claude-glm-auto --auto-config-dir ~/.claude_glm --glm-quota --json
claude-glm-auto --auto-config-dir ~/.claude_glm --install-statusline
```

`--glm-quota` 每次重新查询，按账号显示五小时、周、MCP 月度额度和重置时间。`--json` 输出规范化数据：顶层包含 `source`、`accounts`、`fetchedAt`、`configError`；每个账号包含 `id`、`name`、`quota`、`stale`、`error`。`quota` 内为 `tokens`、`weekly`、`monthly` 和读取时间。输出不含密钥。

`--install-statusline` 为当前机器生成命令，更新指定配置目录内的 `settings.json` 的 `statusLine` 字段。首次安装前，将原文件保存为 `settings.json.before-glm-statusline`；重复安装保持同一备份。原有模型设置和其他配置不变。需要撤销时，可从备份中恢复原来的 `statusLine` 字段。

状态栏示例：

```text
主账号 5h 82% @14:35／周 未提供 | 备用账号 5h 44%／周 73% @10/26 20:03
```

百分比后跟 `@` 的就是重置时刻：当天只显示时分，跨天补上日期；接口对零消耗的窗口不提供重置时间，此时只显示百分比。

`--statusline` 是内置的状态栏命令，读取 Claude Code 通过标准输入传入的会话 JSON，显示统一额度模块的结果。无需复制 Python 脚本，也不需要解析查询命令的自然语言输出。

标题栏汇总账号池，例如 `GLM 未触顶 1/3 · 未知 1`。五小时额度小于 100%，且返回的周额度也未触顶时，标记为“未触顶”；它不保证中转站会选中该账号。

缺少某个窗口显示“未提供”，不推断为无限额度。查询失败显示“未知”，或明确标注“查询失败，上次数据”。状态栏与终端标题共用配置目录里的 `glm-quota-cache.json`，五分钟内复用缓存；自动恢复判断会重新查询。缓存只保存规范化的用量数据和配置修改时间信息，不保存密钥和原始响应。

## 自动续跑规则

本工具通过伪终端运行 Claude Code，并用 headless xterm 镜像读取实际屏幕。正常工作时，额度读数只用于显示，不会主动打断请求。

遇到 `● API Error:` 时：

1. **临时网络错误、过载、证书故障等**：按 15 秒、30 秒、1 分钟、2 分钟、5 分钟的阶梯尝试发送 `continue`。额度接近上限不会把网络错误变成数小时等待。
2. **上游额度错误**：重新查询全部账号。有账号未触顶时短间隔重试，让中转站执行自己的账号调度；全部账号明确触顶且重置时间完整时，等待账号池最早可能恢复的时刻。
3. **账号数据不完整或查询失败**：每五分钟重新查询并进行一次续跑尝试。中转站错误中提到的单账号重置时间，不会被当成整个账号池的恢复时间。
4. **明确的密钥失效、鉴权失败或中转站余额不足**：标题栏显示原因，停止自动重试。处理好问题后可手动继续。

一个账号同时耗尽五小时和周额度时，等待两个重置时间中较晚的一个；多个账号之间取最早可能恢复的账号。MCP 月额度仅显示，不阻止模型恢复。过期的重置时间不能支持新的长等待。

等待期间，每五分钟更新账号列表和额度。账号提前恢复、升级套餐或新增可用账号后，可以提前尝试续跑；若提前恢复立刻再次触顶，会抑制同一信号，避免反复快速重试。新增的其他可用账号仍可触发恢复。

所有恢复路径共用一个发送出口。Claude 自己正在重试、显示菜单或询问是否从摘要恢复时，发送会等待。按 **F4** 或在等待期间输入任何内容，会取消当前自动续跑；用户输入也会使正在进行的异步额度判断失效。

进程持续运行、终端仍可交互时，工具会按上述规则尝试恢复。官方额度恢复后，中转站仍需正确调度且网络可用，任务才能继续。并行会话各自处理恢复，不集中调度模型请求。

## 在其他机器或计算服务器上使用

每台机器执行相同安装流程，准备自己的 Claude 配置目录和账号文件，再运行 `--install-statusline`。安装命令会根据当前机器的 Node 和程序位置生成路径，仓库不保存个人绝对路径、域名或真实密钥。移动安装目录或更换 Node 安装位置后，重新构建并安装状态栏。

使用 SSH、计算服务器或任务节点时，保证进程在运行且具备交互终端；可在已有的 tmux/screen 会话内使用。该机器需要能够访问中转站及官方额度接口。Node 的内置 `fetch` 不自动读取 `HTTP_PROXY`；如需代理，使用该 Node 版本支持的网络代理配置。

Windows 使用同样的 Node CLI。安装全局命令后，例如：

```powershell
claude-glm-auto --auto-config-dir "$HOME\.claude_glm" --glm-quota
claude-glm-auto --auto-config-dir "$HOME\.claude_glm" --install-statusline
```

## 参数

| 参数 | 作用 |
| :-- | :-- |
| `--auto-config-dir <目录>` | 指定 Claude 配置目录，支持 `~`，转换为当前机器的绝对路径 |
| `--auto-accounts-file <文件>` | 指定账号文件；与别名或状态栏安装一起使用时也会写入安装命令 |
| `--glm-quota` | 重新查询全部账号并退出；配置错误或全部查询失败时退出码为 1 |
| `--glm-quota --json` | 输出不含密钥的结构化额度数据 |
| `--statusline` | 输出底部状态栏，复用五分钟缓存；查询失败也输出可见提示 |
| `--install-statusline` | 安装本机适用的底部状态栏命令 |
| `--install-alias` / `--uninstall-alias` | 管理 `claude` 的 shell 别名 |
| `--no-auto-mode` | 不默认传递 `--permission-mode bypassPermissions` |
| `--auto-debug` | 将屏幕与恢复决策写入工作目录的 `claude-glm-auto.log` |
| `GLM_QUOTA_URL` | 覆盖所有账号的额度接口，主要用于本地模拟测试 |
| `CGA_TIME_SCALE` | 测试用时间缩放系数，默认 1 |

普通会话默认向 Claude Code 传递 `--permission-mode bypassPermissions`，避免离线续跑时卡在权限确认或 auto 模式权限分类器上。显式指定权限模式，或使用 `--dangerously-skip-permissions` 时，沿用你的选择。从未接受过 bypass 的配置目录首次启动可能弹一次性确认，在该目录 settings.json 里加 `skipDangerousModePermissionPrompt: true` 可预先跳过。

## 开发与验证

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

单元及模块集成测试验证窗口分类、账号池恢复时间、缓存、配置变更、密钥分离和状态栏安装。端到端测试用本地模拟额度接口与假 Claude CLI，在加速时钟下验证终端续跑、提前恢复、失败探测、用户接管、中转站故障以及第三个账号加入。测试不读取个人真实密钥、不调用模型。

项目源自 [Darkblader24/claude-auto](https://github.com/Darkblader24/claude-auto)，保留 MIT 许可证。

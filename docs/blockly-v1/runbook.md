# Blockly Data Transform 真实 Runtime 验收手册

## 结论

本验收走真实的 n8n 社区节点加载链路，而不是“把某个 `dist` 目录当成自定义节点目录”：

```text
打包 n8n-nodes-blockly-code
  → 解包到隔离 N8N_USER_FOLDER/.n8n/nodes/node_modules
  → n8n CLI 导入 workflow
  → internal secure JavaScript Task Runner 执行
  → 提取 --rawOutput 中的 execution JSON
  → 校验三条业务输出和 pairedItem
```

workflow 中的节点类型始终是：

```text
n8n-nodes-blockly-code.blocklyCode
```

脚本只使用 `scripts/blockly-v1/fixtures/blockly-data-transform-v1.workflow.json` 里的通用数据转换案例，RoboFrame 插件不参与本验收。

## 一次运行

在仓库根目录执行：

```bash
node scripts/blockly-v1/runtime-acceptance.mjs
```

脚本自动完成以下工作：

1. 检查共享编译器、社区节点、基础节点、Task Runner 和 CLI 的现有构建产物。
2. 用共享编译器校验 fixture 的结构、连接、workspace 和 canonical preview，并确认其中只有一个包名限定的 Blockly 节点。
3. 在 `scripts/blockly-v1/.runtime/acceptance/` 下创建独立运行目录。
4. 将 n8n CLI 端口固定为 `5678`，再自动选择一个空闲的本机 Task Runner broker 端口；两者均排除 `8080`。
5. 显式启用 community/unverified package loader，用 `pnpm pack` 生成社区节点 tarball，再解包到隔离用户目录的 `node_modules`。
6. 清除调用者环境中已有的 n8n、数据库、执行模式、队列、节点过滤和外部 hook 配置，再写入隔离验收白名单；SQLite 固定在本次 `N8N_USER_FOLDER/.n8n/database.sqlite`，fixture 校验固定使用仓库内共享编译器。
7. 调用真实 n8n CLI 导入并执行 workflow；执行模式固定为 `internal`，secure runner 配置固定为 `N8N_RUNNERS_INSECURE_MODE=false`。
8. 断言本次 broker 端口已就绪、JavaScript Task Runner 已注册，且日志中没有 insecure runner 警告。
9. 从 n8n 启动日志前缀之后提取 execution JSON，再调用 `verify-execution.mjs`。
10. 保留完整 runtime 与 evidence，便于复查。

成功输出的核心内容是：

```text
PASS: execution returned 3 expected one-to-one Blockly outputs
PASS: real n8n runtime loaded n8n-nodes-blockly-code.blocklyCode from the isolated community package
```

## 已有构建产物时的快速检查

```bash
node scripts/blockly-v1/runtime-acceptance.mjs --check
node --test scripts/blockly-v1/runtime-acceptance.test.mjs
```

`--check` 只读检查运行所需的 `dist` 文件，并调用 `verify-v1.mjs --require-compiler` 完整验证 fixture。缺少构建产物时，脚本会逐项打印需要执行的 `pnpm --filter ... build` 命令，并为每条命令给出重定向日志路径。

完整构建命令如下：

```bash
node -e "require('node:fs').mkdirSync('scripts/blockly-v1/.runtime',{recursive:true})"
pnpm --filter @n8n/blockly-data-transform build > scripts/blockly-v1/.runtime/shared-compiler-build.log 2>&1
pnpm --filter n8n-nodes-blockly-code build > scripts/blockly-v1/.runtime/community-node-build.log 2>&1
pnpm --filter n8n-nodes-base build > scripts/blockly-v1/.runtime/nodes-base-build.log 2>&1
pnpm --filter @n8n/task-runner build > scripts/blockly-v1/.runtime/task-runner-build.log 2>&1
pnpm --filter n8n build > scripts/blockly-v1/.runtime/cli-build.log 2>&1
```

运行环境还需要 Node.js、pnpm，以及 Windows/Linux 均常见的 `tar` 命令。

## 指定独立证据目录

默认目录带时间戳与进程号，每次运行互不覆盖。也可以指定一个新的空目录作为绝对路径：

```bash
node scripts/blockly-v1/runtime-acceptance.mjs --runtime-dir=/absolute/path/blockly-runtime
```

Windows PowerShell 示例：

```powershell
node scripts/blockly-v1/runtime-acceptance.mjs --runtime-dir="$env:TEMP\blockly-runtime-acceptance-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
```

## 证据结构

每次成功运行至少保留：

```text
<runtime>/
├─ package/
│  └─ n8n-nodes-blockly-code-*.tgz
├─ n8n-user/
│  └─ .n8n/
│     ├─ database.sqlite
│     └─ nodes/node_modules/n8n-nodes-blockly-code/
└─ evidence/
   ├─ runtime-config.json
   ├─ installed-package.json
   ├─ 01-pack.*.log
   ├─ 02-unpack.*.log
   ├─ 03-fixture.*.log
   ├─ 04-import.*.log
   ├─ 05-execute.*.log
   ├─ execution.json
   ├─ 06-verify.*.log
   └─ result.json
```

判断边界：

- `installed-package.json` 证明 tarball 中的包名与 n8n 节点入口。
- `04-import` 与 `05-execute` 的退出码由脚本强制检查。
- `05-execute.stdout.log` 保留 broker、runner 注册等启动日志以及原始 `--rawOutput`。
- `execution.json` 是从日志前缀中提取出的结构化执行记录。
- `06-verify.stdout.log` 与 `result.json` 证明三条输出、顺序和 `pairedItem` 均符合 fixture。
- `runtime-config.json` 记录 n8n CLI 端口、实际 broker 端口与 secure runner 模式；端口不是 `8080`。

## Secure runner 的额外进程证据

脚本会显式设置 `N8N_RUNNERS_MODE=internal` 与 `N8N_RUNNERS_INSECURE_MODE=false`。若发布材料还要求保存 runner 启动参数，可在执行期间记录子进程命令行；secure JavaScript runner 应包含：

```text
--disallow-code-generation-from-strings
--disable-proto=delete
```

Windows PowerShell：

```powershell
Get-CimInstance Win32_Process |
  Where-Object CommandLine -Match '@n8n[\\/]task-runner[\\/]dist[\\/]start\.js' |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

Linux：

```bash
ps -axww -o pid=,ppid=,command= | grep '/packages/@n8n/task-runner/dist/start.js' | grep -v grep
```

## 清理范围

验收脚本不会启动常驻 Web 服务，CLI 执行结束后 broker 与 internal runner 随主进程退出。运行数据全部位于本次输出的 `<runtime>` 目录；复核结束后，只清理该目录即可，其他 n8n 用户目录与服务保持原状。

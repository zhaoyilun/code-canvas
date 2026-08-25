# 通用代码双画布课堂演示手册

## 演示目标

在同一个可导入工作流中完成两条连续路径：

1. `price = 12.5`、`quantity = 4` 经过现成的 schema v3 Blockly 逻辑得到 `total = 52`。
2. `score = 125` 遇到未知函数 `clampScore/3` 后，点击一次 **AI 生成模块**，双画布自动刷新，再次运行得到 `score = 100`。

工作流固定为：

```text
Manual Trigger → Set(price, quantity, score) → Blockly Code
```

服务端口固定为后端 `5678`、前端 `18181`；`8080` 保持空闲。Codex 全程保持当前运行状态，User 级密钥由后端 PowerShell 进程临时读取。

## 一、准备依赖与社区节点

以下命令均在 PowerShell 中执行，包管理器统一使用 `pnpm`。

```powershell
$Repo = 'E:\coding\codex\n8n-blockly'
Set-Location -LiteralPath $Repo

pnpm install --frozen-lockfile
pnpm --filter @n8n/dual-canvas-operation-runtime build
pnpm --filter @n8n/blockly-data-transform build
pnpm --filter n8n-nodes-blockly-code build
pnpm --filter n8n... build
pnpm --filter n8n-editor-ui... build
```

将刚构建的 Blockly Code 社区节点装入独立演示目录。这里沿用真实运行验收所用的 `pnpm pack → .n8n/nodes/node_modules` 布局，不影响日常 n8n 数据：

```powershell
$DemoRoot = Join-Path $Repo 'scripts\education\.runtime\interactive-dual-canvas-demo'
$PackageOut = Join-Path $DemoRoot 'package'
$N8nUser = Join-Path $DemoRoot 'n8n-user'
$InstalledNode = Join-Path $N8nUser '.n8n\nodes\node_modules\n8n-nodes-blockly-code'

New-Item -ItemType Directory -Force -Path $PackageOut, $InstalledNode | Out-Null
pnpm --dir (Join-Path $Repo 'custom-nodes\n8n-nodes-blockly-code') pack --pack-destination $PackageOut

$Tarball = Get-ChildItem -LiteralPath $PackageOut -Filter '*.tgz' |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if ($null -eq $Tarball) { throw 'pnpm pack did not create a tarball' }

tar -xzf $Tarball.FullName --strip-components=1 -C $InstalledNode
if ($LASTEXITCODE -ne 0) { throw 'community-node extraction failed' }
```

## 二、启动后端：5678

继续使用上一步的 PowerShell 窗口。密钥只从 User 级环境变量读入当前后端进程，命令行和日志均不包含密钥值：

```powershell
$UserApiKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
if ([string]::IsNullOrWhiteSpace($UserApiKey)) {
  throw 'User-scope DEEPSEEK_API_KEY is empty'
}

$env:DEEPSEEK_API_KEY = $UserApiKey
Remove-Variable UserApiKey
$env:N8N_USER_FOLDER = $N8nUser
$env:N8N_PORT = '5678'
$env:N8N_COMMUNITY_PACKAGES_ENABLED = 'true'
$env:N8N_UNVERIFIED_PACKAGES_ENABLED = 'true'
$env:N8N_COMMUNITY_PACKAGES_PREVENT_LOADING = 'false'
$env:N8N_RUNNERS_MODE = 'internal'
$env:DB_TYPE = 'sqlite'
$env:DB_SQLITE_POOL_SIZE = '1'

try {
  pnpm dev:be
} finally {
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
}
```

当前后端实现已经固定使用：

- Base URL：`https://api.deepseek.com`
- 模型：`deepseek-v4-flash`

因此本轮演示只需要 `DEEPSEEK_API_KEY`，不再增加模型或 URL 配置项。

## 三、启动前端：18181

打开第二个 PowerShell 窗口：

```powershell
Set-Location -LiteralPath 'E:\coding\codex\n8n-blockly'
pnpm dev:fe:editor
```

仓库实际脚本会把编辑器启动在 `http://localhost:18181`，并把 API 基址指向 `http://localhost:5678/`。可在第三个 PowerShell 窗口确认监听状态：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 5678,18181 |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

首次打开 `http://localhost:18181` 时，按页面提示建立本地演示账号。该账号保存在上面的独立 `$N8nUser` 目录中，之后可重复使用。

## 四、导入课堂工作流

1. 打开 `http://localhost:18181` 并进入一个工作流画布。
2. 打开顶部工作流操作菜单，选择 **Import from File**。
3. 选择：

   ```text
   E:\coding\codex\n8n-blockly\docs\education\examples\interactive-dual-canvas-demo.workflow.json
   ```

4. 确认画布顺序为 **Start → Seed numeric input → Numeric calculation**。
5. 确认教学工作台显示 **输入 → 双画布 → 运行** 三个阶段。

导入文件已经内嵌 `numeric-calculation` 的 schema v3 转换产物，初始 operation catalog 为空，无需先调用 AI。

## 五、基础案例：得到 total = 52

1. 打开 **Seed numeric input**，确认三个数值：`price = 12.5`、`quantity = 4`、`score = 125`。
2. 点击 **Execute workflow**。
3. 打开 **Numeric calculation** 的输出，确认：

   ```json
   {
     "total": 52
   }
   ```

4. 打开 **Numeric calculation** 节点的 **逻辑** 参数。此时产品的“双画布”是外层 n8n 工作流画布与节点内 Blockly 画布；右侧实时 JavaScript 预览是额外的教学辅助视图。三处共同表达 `price * quantity + 2`。
5. 也可在 **示例程序** 中选择 **数值计算（直接转换）**，点击 **转换为双画布**，观察下方积木和 JavaScript 预览同步刷新，再运行一次确认结果仍为 `52`。

## 六、未知函数案例：clampScore/3 → score = 100

1. 保持 **Numeric calculation** 节点的逻辑编辑页打开。
2. 在 **示例程序** 中选择 **成绩限幅（AI 生成函数）**。
3. 点击 **转换为双画布**。
4. 页面先显示 **发现缺少函数模块**，函数签名为 `clampScore / 3 个参数`；这一步证明仓库现有 catalog 中尚无该模块。
5. 点击 **AI 生成模块**。后端调用固定的 `deepseek-v4-flash`，将新模块加入当前 payload 的 operation catalog，并自动重新导入源码。
6. 等待缺失模块提示消失；下方 Blockly 工作区与 JavaScript 预览会自动刷新为成绩限幅逻辑。
7. 保存工作流，然后点击 **Execute workflow**。
8. 打开 Blockly 节点输出，确认输入 `score = 125` 被限幅为：

   ```json
   {
     "score": 100
   }
   ```

## 完成判据

- 导入后可见三个节点和 **输入 / 双画布 / 运行** 三阶段。
- 普通数值案例一次运行得到 `total = 52`。
- 成绩案例首次转换显示 `clampScore/3` 缺失。
- 点击 **AI 生成模块** 后双画布自动刷新。
- 第二次运行得到 `score = 100`。
- 用户访问端口为后端 `5678` 与前端 `18181`；内部 Task Broker 会使用独立端口，演示过程未占用 `8080`。

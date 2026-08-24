# 基础代码到真实 n8n Runtime 的合流验收

## 结论和定位

这项验收把此前分开的两道门连成一条真实执行链：

```text
numeric-calculation.ts
  → TypeScript importer
  → VisualProgramIRV1
  → Blockly workspace / payload
  → 正式 n8n workflow
  → n8n-nodes-blockly-code.blocklyCode
  → internal secure JavaScript Task Runner
  → { total: 52, pairedItem: 0 }
```

它验证的是通用教育能力，不含 RoboFrame、GPIO 或设备依赖。输入代码来自
`docs/education/examples/generic-snippets/numeric-calculation.ts`，运行时输入固定为：

```json
{
  "price": 12.5,
  "quantity": 4
}
```

源码中的计算为 `price * quantity + 2`，因此期望输出严格为：

```json
{
  "json": { "total": 52 },
  "pairedItem": { "item": 0 }
}
```

## 运行方式

先检查 importer 产物、源码映射、Blockly 编译结果和完整 workflow 的确定性：

```bash
node scripts/education/numeric-runtime-acceptance.mjs --check
node --test scripts/education/numeric-runtime-acceptance.test.mjs
```

再执行真实 n8n Runtime：

```bash
node scripts/education/numeric-runtime-acceptance.mjs
```

也可以指定一个全新的隔离目录：

```powershell
node scripts/education/numeric-runtime-acceptance.mjs `
  --runtime-dir="$env:TEMP\n8n-numeric-runtime-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
```

运行器复用 `scripts/blockly-v1/runtime-acceptance.mjs` 的高层隔离运行接口。社区节点以
`n8n-nodes-blockly-code` 正式包安装并按
`n8n-nodes-blockly-code.blocklyCode` 加载，不经过 `CUSTOM.*` 类型或自定义扩展目录。

## 运行时隔离契约

| 项目 | 固定契约 |
|---|---|
| n8n 用户目录 | 每次验收使用新的 `N8N_USER_FOLDER` |
| n8n 主端口 | `5678` |
| Task Runner 模式 | `internal` |
| Task Runner 安全模式 | `N8N_RUNNERS_INSECURE_MODE=false` |
| Task Broker 端口 | 自动选择本机空闲端口，并排除 `8080` |
| 数据库 | 隔离目录内的 SQLite |
| workflow ID | `education-numeric-calculation-runtime-v1` |
| 固定输入节点 | `n8n-nodes-base.set`，`typeVersion=3.4` |
| 社区节点类型 | `n8n-nodes-blockly-code.blocklyCode` |

验收日志还必须同时出现所选 Task Broker 端口的 ready 记录和
`Registered runner "JS Task Runner"`，且不出现不安全运行器警告。

## 证据目录

默认证据保存在：

```text
scripts/education/.runtime/numeric-acceptance/<run-id>/evidence/
```

| 文件 | 证明内容 |
|---|---|
| `source.ts` | 本次 importer 的原始 TypeScript 字节 |
| `import-request.json` | 固定 importer 契约与正式节点绑定 |
| `visual-program-ir.json` | 结构化语义和完整源码映射 |
| `blockly-workspace.json` | 可视化画布与 blockRef |
| `workflow-fragment.json` | importer 直接生成的通用工作流片段 |
| `dual-canvas-document.json` | 双画布文档封装 |
| `workflow.json` | 插入固定输入节点后交给 n8n 的完整工作流 |
| `execution.json` | n8n `execute --rawOutput` 的原始执行记录 |
| `result.json` | 端口、Runner、安全模式、输出和 pairedItem 的最终判定 |
| `artifact-manifest.json` | 生成阶段各文件的路径、字节数和 SHA-256 |
| `runtime-logs/` | package、import、execute 等命令的 stdout/stderr |

## 验收边界

本门通过时，只支持以下结论：基础 TypeScript 代码经 importer 生成 IR、Blockly
workspace 与 Blockly payload，再由 assembly 插入固定 Set 输入并装配成正式 n8n workflow
后，可以由真实 n8n secure Task Runner 执行。其中 Blockly payload 字符串值与 importer
产物逐字符一致，未经重编译或改写；输入、输出、源码映射和 item 配对均有独立证据。
未知函数的模块生成与 RoboFrame 插件接入属于后续独立验收门。

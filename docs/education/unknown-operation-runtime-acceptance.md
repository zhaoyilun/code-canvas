# 未知函数生成模块的完整验收

## 结论和定位

这项验收把“仓库里没有 `clampScore`”从一次导入诊断闭合为可视化、可执行的新模块：

```text
首次导入
  → OPERATION_MODULE_MISSING
  → 严格 ModuleDraft JSON（implementationRef: null）
  → finalizeOperationModuleSpecV1 派生不可变实现身份
  → 4 个测试向量通过
  → OperationModuleCatalogV1
  → 带目录重新导入
  → operationCall IR / 动态 Blockly 积木
  → 正式 n8n Blockly Code 节点
  → internal secure JavaScript Task Runner
  → { score: 100, pairedItem: 0 }
```

输入源码为 `docs/education/examples/unknown-operation-clamp.ts`。模块生成器只填写受限的
声明式 draft JSON；宿主只接收 `implementationRef: null` 的严格 draft，再根据完整语义生成
不可变的 `implementationRef`。积木定义、工具箱、
JavaScript 编译和运行再由同一份目录确定性完成。核心链路不含 RoboFrame 依赖。

## 运行方式

先在仓库根目录按依赖顺序生成快速门使用的五个 `dist`：

```bash
pnpm --filter @n8n/dual-canvas-operation-runtime exec tsc -b tsconfig.build.json --force
pnpm --filter @n8n/dual-canvas-core exec tsc -b tsconfig.build.json --force
pnpm --filter @n8n/dual-canvas-operation-sdk exec tsc -b tsconfig.build.json --force
pnpm --filter @n8n/dual-canvas-typescript-importer exec tsc -b tsconfig.build.json --force
pnpm --filter @n8n/blockly-data-transform exec tsc -b tsconfig.build.json --force
```

验收脚本会检查每个 `dist/index.js` 存在，并以 `dist/build.tsbuildinfo` 作为整包 build marker，
确认它晚于对应 production `src`、`package.json` 和上游 runtime build marker。`--force` 只重建
这五个小包，用于让 manifest-only 变更也产生可核验的新 marker。缺失或过期时会列出应按顺序
执行的具体 build 命令；脚本本身不隐式构建。
然后运行本地确定性和 `node:vm` 等价门：

```bash
node scripts/education/unknown-operation-runtime-acceptance.mjs --check
node --test scripts/education/unknown-operation-runtime-acceptance.test.mjs
```

真实 n8n Runtime 还需要构建待打包的社区节点和 n8n 基础运行件：

```bash
pnpm --filter n8n-nodes-blockly-code build
pnpm --filter n8n-nodes-base build
pnpm --filter @n8n/task-runner build
pnpm --filter n8n build
```

社区节点的 freshness 门会把节点 production 源码、`package.json`、bundle 脚本、operation
runtime `dist` 和 data-transform `dist` 一起纳入校验，随后才允许 `pnpm pack`。完成上述构建后
执行真实 n8n Runtime：

```bash
node scripts/education/unknown-operation-runtime-acceptance.mjs
```

也可以指定全新的隔离目录：

```powershell
node scripts/education/unknown-operation-runtime-acceptance.mjs `
  --runtime-dir="$env:TEMP\n8n-operation-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
```

## 固定契约

| 项目 | 固定值 |
|---|---|
| 未知函数 | `clampScore/3` |
| 模块逻辑身份 | 由首次诊断请求稳定派生的 `operationRef`；同一函数身份保持稳定 |
| 模块实现身份 | 由执行语义与 Blockly ABI 稳定派生的 `implementationRef`；表达式变化即生成新身份 |
| 模块版本 | `1.0.0` |
| 固定输入 | `{ "score": 125 }` |
| 固定输出 | `{ "json": { "score": 100 }, "pairedItem": { "item": 0 } }` |
| n8n 主端口 | `5678` |
| Task Broker 端口 | 自动选空闲端口并排除 `8080` |
| Task Runner | `internal`，安全模式开启 |
| 正式节点类型 | `n8n-nodes-blockly-code.blocklyCode` |
| workflow ID | `education-unknown-operation-clamp-runtime-v1` |

## 证据目录

默认证据位于：

```text
scripts/education/.runtime/unknown-operation/<run-id>/evidence/
```

核心证据包括首次诊断、scaffold request、template、`implementationRef: null` 的严格 draft、
带不可变实现身份的 ModuleSpec、admission、测试向量结果、
operation registry、注册后请求、VisualProgramIR、logic IR、Blockly workspace/payload、调用级源码映射、
`node:vm` 三路等价结果、正式 workflow、真实 execution、端口与 Task Runner 日志，以及记录
字节数和 SHA-256 的 manifest。

## 支持的结论

本门通过后，可以确认：纯同步、确定性、无副作用的缺失函数，能够按固定声明式格式生成，
经测试向量准入后成为通用 Blockly 函数模块，并由同一目录驱动导入、编辑、保存、编译和真实
n8n 执行。网络、设备、异步和其他有副作用能力继续由独立插件承载。

这里的两层身份分别回答“这是哪个逻辑函数”和“这次保存、显示、编译、执行的是哪份实现”。
同一 `operationRef` 下修改表达式会得到新的 `implementationRef` 和 Blockly `blockType`，旧画布
仍指向旧实现，不会被同名新逻辑静默替换。

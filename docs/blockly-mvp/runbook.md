# Blockly Code MVP 运行手册

> 基线：n8n `2.35.4`、pnpm `10.32.1`、Node.js `>=22.22`。所有命令从仓库根目录执行。

## 1. 安装依赖

```bash
pnpm install
```

依赖位置如下：

- `pnpm-workspace.yaml`：`custom-nodes/*` workspace 与 `blockly: 12.3.1` catalog；
- `packages/frontend/editor-ui/package.json`：`"blockly": "catalog:"`；
- `custom-nodes/n8n-nodes-blockly-code/package.json`：custom node 的构建、lint、测试与开发依赖；
- `pnpm-lock.yaml`：Blockly、custom node importer 和传递依赖的锁定结果。

## 2. 构建 workflow 类型

`blocklyEditor` 类型定义在 `packages/workflow/src/interfaces.ts`。当前分支已验证的构建方式是从仓库根目录调用 TypeScript 6 并强制重建：

```bash
pnpm exec tsc --build \
  packages/workflow/tsconfig.build.esm.json \
  packages/workflow/tsconfig.build.cjs.json \
  --force
```

另有一项独立的基线问题：最近一次标准 TypeScript 7 clean build 曾在 `execution-cancelled.error.ts` 和 `expression.error.ts` 的两个 `level` 类型位置失败。它与 Blockly editor-ui full typecheck 的 Canvas 测试阻断不是同一问题。

## 3. 检查并构建 custom node

```bash
pnpm --dir custom-nodes/n8n-nodes-blockly-code lint
pnpm --dir custom-nodes/n8n-nodes-blockly-code exec tsc --noEmit
pnpm --dir custom-nodes/n8n-nodes-blockly-code test
pnpm --dir custom-nodes/n8n-nodes-blockly-code build
```

构建后必须存在：

```text
custom-nodes/n8n-nodes-blockly-code/dist/nodes/BlocklyCode/BlocklyCode.node.js
```

custom node 的 lint、`tsc --noEmit`、14/14 tests 和 build 均已验证 PASS。生产代码不再把 `getNodeParameter()` 强制断言为字符串；非字符串参数校验已有测试覆盖。

## 4. 构建并检查 editor-ui

开发模式：

```bash
pnpm dev:fe
```

也可以生成 production 前端产物；按仓库约定将构建输出写入日志：

```bash
pnpm --filter n8n-editor-ui build > build-blockly-editor-ui.log 2>&1
tail -n 20 build-blockly-editor-ui.log
```

当前已验证结果：

- editor dependencies build：29/29 PASS；
- Blockly payload/editor tests：10/10 PASS，其中第 10 项覆盖载入 workspace 后重新生成 canonical JavaScript；
- P1 挂载保护已修复：仅有效 payload 且 workspace 载入成功时自动 emit canonical payload；非法、未知或载入失败时只显示默认工作区，不自动持久化；
- canonical serialization 会 trim JavaScript 尾空白，使 default、fixture 和 UI 保存值一致；
- Blockly 容器使用确定的 `height: 24rem`；实机曾证明仅设置 `min-height` 会让 Blockly `.injectionDiv` 高度为 0，造成可访问树存在但画面空白；
- `ParameterInput.test.ts`：56/56 PASS；
- editor-ui lint：exit 0；
- production build：PASS，并产出独立 Blockly chunk；已观察到 `dist/assets/blockly-CU9BVUMX.js`，内容 hash 后续构建可能变化。

editor-ui full typecheck 尚未整体通过，但当前只被未修改的 `CanvasNodeDefault.test.ts` 中两个 CSS custom-property TS2353 阻断：`--canvas-node--height` 与 `--canvas-node--width`。这两处不能归因于 Blockly。

## 5. 导入 fixture：CLI 不需要 owner setup

验收脚本使用隔离目录 `scripts/blockly-mvp/.runtime/n8n-user`。先检查构建产物，然后可直接在全新隔离数据库导入 fixture：

```bash
scripts/blockly-mvp/setup-demo.sh --check
scripts/blockly-mvp/setup-demo.sh --import
```

`--import` 已验证可在未完成 browser owner setup 的全新隔离数据库中成功导入 1 个 workflow。fixture 节点类型必须是：

```text
CUSTOM.blocklyCode
```

这是 `N8N_CUSTOM_EXTENSIONS` 直载的真实类型；不要改回 `n8n-nodes-blockly-code.blocklyCode`。

导入后的 workflow 也已通过官方 CLI 导出：

```bash
N8N_USER_FOLDER=scripts/blockly-mvp/.runtime/n8n-user \
N8N_CUSTOM_EXTENSIONS=custom-nodes/n8n-nodes-blockly-code/dist \
packages/cli/bin/n8n export:workflow \
  --id=blockly-code-mvp-demo \
  --output=scripts/blockly-mvp/.runtime/blockly-code-demo.exported.json
```

结果为 `Successfully exported 1 workflow`。导出文件是官方单 workflow 数组格式，路径为：

```text
scripts/blockly-mvp/.runtime/blockly-code-demo.exported.json
```

验证器同时支持单对象 fixture 和官方数组导出；两者当前均为 PASS：

```bash
node scripts/blockly-mvp/verify-payload.mjs \
  scripts/blockly-mvp/fixtures/blockly-code-demo.workflow.json
node scripts/blockly-mvp/verify-payload.mjs \
  scripts/blockly-mvp/.runtime/blockly-code-demo.exported.json
```

## 6. 启动实例

运行时加载路径必须是 package 的 `dist`：

```bash
export N8N_CUSTOM_EXTENSIONS="$PWD/custom-nodes/n8n-nodes-blockly-code/dist"
scripts/blockly-mvp/run-demo.sh
```

脚本会使用隔离数据库，并把日志写入 `scripts/blockly-mvp/.runtime/logs/`。当前现场实例已启动在 `http://localhost:5678`，JavaScript task runner 已 ready。

如采用源码开发模式，可分别启动后端与前端：

```bash
N8N_CUSTOM_EXTENSIONS="$PWD/custom-nodes/n8n-nodes-blockly-code/dist" pnpm dev:be
pnpm dev:fe
```

workspace 中的 `custom-nodes/*` 只用于开发构建，不替代 `N8N_CUSTOM_EXTENSIONS`。

## 7. CLI 执行：技术链路已通过

导入后执行：

```bash
N8N_USER_FOLDER=scripts/blockly-mvp/.runtime/n8n-user \
N8N_CUSTOM_EXTENSIONS=custom-nodes/n8n-nodes-blockly-code/dist \
packages/cli/bin/n8n execute --id=blockly-code-mvp-demo --rawOutput
```

当前真实证据：

- JavaScript Task Runner 注册成功；
- `Blockly Code` 节点 status 为 `success`；
- 输出包含 `{"result":42}`；
- 日志：`scripts/blockly-mvp/.runtime/logs/cli-execute-20260820-160421.log`；
- 日志中的 `resumeToken` 已脱敏，不应恢复、复制或记录原值。

因此 CLI 技术链路为 PASS，但该结果本身不能替代浏览器 UI 业务验收；当前 UI 验收结果见下一节。

## 8. 浏览器 owner setup 与 UI 验收

CLI import 不要求 owner setup；进入 n8n editor UI 仍要求 owner setup。owner setup 应由用户在浏览器中自行完成，密码不得放入命令、日志、截图或文档。当前隔离实例已由用户完成 setup，并完成以下 UI 验收：

1. Overview 中可见并打开 `Blockly Code MVP Demo`。
2. 节点创建器搜索到 `Blockly Code`；点击后真实新增 `Blockly Code1` 并打开默认 Blockly。验收后已删除临时节点。
3. `Blockly Payload` 显示可操作的 Blockly 编辑器，默认 workspace 是 return block + `math_number 42`。
4. 从 Math 工具箱真实拖入数值积木，观察到 `PATCH /rest/workflows/blockly-code-mvp-demo` 返回 200。
5. 刷新后临时积木仍存在，证明 workspace 已持久化；验收后删除临时积木，恢复规范 payload。
6. 官方 CLI 导出最终 UI 工作流到 `scripts/blockly-mvp/.runtime/blockly-code-demo.ui-exported.json`；payload verifier PASS，最终节点数为 2。
7. 从浏览器执行最终工作流，Output 表格显示 `result = 42`；隔离 SQLite 最新 manual execution id `4` 为 `success`。

截图：

```text
output/playwright/blockly-workflow-canvas.png
output/playwright/blockly-node-creator.png
output/playwright/blockly-node-added.png
output/playwright/blockly-editor.png
output/playwright/blockly-after-drag.png
output/playwright/blockly-reloaded.png
output/playwright/blockly-execution-result.png
```

P1 负向行为可单独核验：为参数提供非法 JSON、未知 schema 或无法载入的 workspace 时，编辑器可以显示默认工作区，但在用户未编辑前不得自动改变原参数；用户实际拖动、修改或连接积木后才应回写新的 canonical payload。

定义范围内的本地 UI MVP 已 PASS。默认 runner 日志不输出每个 UI execution 的 job ID，因此以 UI 输出和 SQLite execution 记录关联执行。新增 custom node 时 `/schemas/CUSTOM.blocklyCode/1.0.0.json` 返回 404，但不影响本次编辑与执行；产品化时如需节点 schema/docs，应另行实现。

## 常见阻断

- 找不到节点：检查 `N8N_CUSTOM_EXTENSIONS` 是否指向真实存在的 `dist`，fixture type 是否为 `CUSTOM.blocklyCode`，并检查节点加载日志。
- 显示普通字符串框：检查 `n8n-workflow` 类型产物、`ParameterInput.vue` 接缝和当前前端产物。
- 保存后丢失：检查 `parameters.blocklyPayload` 是否为可解析 JSON 字符串。
- CLI 可执行但 UI 不可进入：检查是否停在 `/setup`；这需要用户完成 owner setup，不是 custom node 加载失败。
- 执行失败：检查 payload 的 `schemaVersion`、`workspace`、`javascript`，以及 JavaScript task runner 的启动和连接日志。

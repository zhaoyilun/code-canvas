# Blockly Code MVP 验收

> 当前结论：定义范围内的本地 MVP 业务闭环 PASS。已真实验证节点创建器、Blockly 可视编辑与拖拽、自动保存与重载、workflow 导出，以及浏览器手工执行输出 `result = 42`。这不代表生产安全或完整产品就绪。

## 当前验证状态

| 范围 | 结果 | 真实证据或说明 |
| --- | --- | --- |
| custom node lint / typecheck / tests / build | PASS | lint、`tsc --noEmit`、14/14 tests、build 均通过，`dist` 已生成。 |
| custom node 参数类型校验 | PASS | 已移除 `getNodeParameter()` 的 `as string`；非字符串参数在进入解析和 task runner 前被拒绝。 |
| payload 与 shell checks | PASS | fixture schema、return block、`math_number 42`、JavaScript 和脚本语法通过。 |
| P1 canonical JavaScript | PASS | 有效 payload 且 workspace 载入成功时重新生成并 emit JavaScript；第 10 项测试证明过期 `result: 7` 被替换为 `result: 42`。 |
| P1 invalid/unknown 挂载保护 | PASS | 非法、未知 schema 或 workspace 载入失败时只显示默认工作区，不自动持久化；用户真实编辑后才回写。 |
| canonical 尾空白 | PASS | serialization 对 JavaScript 执行 `trim()`，default、fixture 与 UI 保存使用一致的无尾空白代码。 |
| editor dependencies build | PASS | 29 successful / 29 total。 |
| Blockly tests | PASS | 10/10。 |
| ParameterInput tests | PASS | 56/56。 |
| editor-ui lint | PASS | exit 0。 |
| editor-ui production build | PASS | 产出 Blockly chunk；已观察到 `dist/assets/blockly-CU9BVUMX.js`。 |
| Blockly 可视布局 | PASS | 实机验收发现仅使用 `min-height` 会使 Blockly `.injectionDiv` 高度为 0；改为确定的 `height: 24rem` 后，工具箱和积木可见，production build 已重跑。 |
| editor-ui full typecheck | 基线阻断 | 仅剩未修改的 `CanvasNodeDefault.test.ts` 两处 CSS custom-property TS2353：`--canvas-node--height`、`--canvas-node--width`；不是 Blockly 失败。 |
| workflow 根 TypeScript 6 force build | PASS | workflow ESM/CJS 配置使用根 TS6 `--force` 构建通过。 |
| workflow 标准 TypeScript 7 clean build | 另一已知基线问题 | 曾因 `execution-cancelled.error.ts` 与 `expression.error.ts` 的两个 `level` TS2353 失败；与 Canvas/Blockly 检查分开记录。 |
| 直载节点身份 | PASS | core 常量为 `CUSTOM`，实际节点类型为 `CUSTOM.blocklyCode`。 |
| 全新隔离 DB CLI import | PASS | 无 browser owner setup 即成功导入 1 个 workflow。 |
| 官方 CLI export | PASS | `Successfully exported 1 workflow`；文件为 `scripts/blockly-mvp/.runtime/blockly-code-demo.exported.json`。 |
| 单对象与数组导出 payload 校验 | PASS | `verify-payload.mjs` 对 fixture 单对象和官方单 workflow 数组导出均通过。 |
| CLI task runner execution | PASS | runner 注册，`Blockly Code` status `success`，输出 `{"result":42}`。 |
| 本地实例与 runner | PASS | `http://localhost:5678` 可达，runner ready。 |
| Playwright UI 入口 | PASS | Overview 可见 `Blockly Code MVP Demo`，工作流画布可见 Manual Trigger、`Blockly Code` 与连线；截图 `output/playwright/blockly-workflow-canvas.png`。 |
| 节点创建器与新增节点 | PASS | 搜索结果可见 `Blockly Code`，点击后实际新增 `Blockly Code1` 并打开默认 Blockly；截图 `output/playwright/blockly-node-creator.png`、`output/playwright/blockly-node-added.png`。验收后已删除临时节点。 |
| Blockly 拖拽与保存重载 | PASS | 从 Math 工具箱拖入数值积木，观察到 workflow PATCH 200；页面重载后积木仍存在。截图 `output/playwright/blockly-after-drag.png`、`output/playwright/blockly-reloaded.png`。验收后已删除临时积木。 |
| 最终 UI 导出 | PASS | 官方 CLI 导出 `scripts/blockly-mvp/.runtime/blockly-code-demo.ui-exported.json`；验证器 PASS，最终仅含 Manual Trigger 与 `CUSTOM.blocklyCode` 两个节点。 |
| 浏览器执行 | PASS | 最终工作流在 UI 中输出 1 item，表格显示 `result = 42`；截图 `output/playwright/blockly-execution-result.png`。SQLite 最新记录 id `4`、mode `manual`、status `success`。 |

## workflow JSON 载荷

`N8N_CUSTOM_EXTENSIONS` 直载时，节点类型固定为 `CUSTOM.blocklyCode`，参数名固定为 `blocklyPayload`：

```json
{
  "type": "CUSTOM.blocklyCode",
  "parameters": {
    "blocklyPayload": "{\"schemaVersion\":1,\"workspace\":{...},\"javascript\":\"return [{ json: { result: 42 } }];\"}"
  }
}
```

workflow JSON 中 `blocklyPayload` 是字符串。解码后必须为：

```json
{
  "schemaVersion": 1,
  "workspace": {
    "blocks": {
      "languageVersion": 0,
      "blocks": [
        {
          "type": "n8n_return_output",
          "x": 24,
          "y": 24,
          "inputs": {
            "VALUE": {
              "block": {
                "type": "math_number",
                "fields": {
                  "NUM": 42
                }
              }
            }
          }
        }
      ]
    }
  },
  "javascript": "return [{ json: { result: 42 } }];"
}
```

P1 已满足以下规则：

1. payload 有效且 workspace 载入成功时，以 `workspace` 重新生成 canonical `javascript`，不继续信任过期 JavaScript；
2. 非法、未知 schema 或 workspace 载入失败时，仅显示默认工作区，不在挂载阶段 emit 或覆盖原参数；
3. 用户产生真实 workspace 编辑后才回写新 payload；
4. serialization trim JavaScript 尾空白，保存值固定为 `return [{ json: { result: 42 } }];`。

## CLI 技术链路 PASS

以下链路已有真实运行证据：

```text
全新隔离 DB
  → CLI import 1 workflow
  → N8N_CUSTOM_EXTENSIONS 直载 CUSTOM.blocklyCode
  → JavaScript Task Runner 注册
  → Blockly Code status success
  → 输出 {result: 42}
  → CLI export 1 workflow
  → fixture 与官方数组导出 payload 校验 PASS
```

执行日志：

```text
scripts/blockly-mvp/.runtime/logs/cli-execute-20260820-160421.log
```

官方导出文件：

```text
scripts/blockly-mvp/.runtime/blockly-code-demo.exported.json
```

该日志中的 `resumeToken` 已脱敏。验收材料只能保留脱敏版本，不得恢复、复制或记录原始 token。

CLI 技术链路可以标记 PASS；它本身不证明节点创建器、Blockly editor、保存重载或浏览器执行。下节记录了独立完成的 UI 证据。

## UI 技术验收与业务 PASS

owner setup 由用户在浏览器中自行完成；自动化没有输入、读取或记录密码。随后使用同一已认证浏览器完成以下链路：

```text
Overview 中打开 Blockly Code MVP Demo
  → 节点创建器搜索并新增 Blockly Code1
  → 打开默认 Blockly 编辑器
  → 从 Math 工具箱拖入数值积木
  → workflow PATCH 200
  → 重载后积木仍存在
  → 删除验收临时积木和临时节点
  → 导出最终两节点 workflow 并通过 payload verifier
  → 浏览器执行 workflow
  → Output 显示 result = 42
  → SQLite manual execution id 4 status success
```

证据文件：

```text
output/playwright/blockly-workflow-canvas.png
output/playwright/blockly-node-creator.png
output/playwright/blockly-node-added.png
output/playwright/blockly-editor.png
output/playwright/blockly-after-drag.png
output/playwright/blockly-reloaded.png
output/playwright/blockly-execution-result.png
scripts/blockly-mvp/.runtime/blockly-code-demo.ui-exported.json
scripts/blockly-mvp/.runtime/logs/n8n-20260820-191652.log
scripts/blockly-mvp/.runtime/logs/ui-acceptance-20260820-1935.log
```

最终导出验证结果：

```text
PASS: Blockly payload connects n8n_return_output.VALUE to math_number=42
PASS: generated JavaScript returns result 42
PASS: final node count=2; types=n8n-nodes-base.manualTrigger,CUSTOM.blocklyCode
```

因此可以对“Blockly → JavaScript → n8n Node Execution”的本地 MVP 定义范围标记业务 PASS。默认服务日志已记录 JavaScript runner 注册，但默认日志级别不输出每次 UI execution 的 runner job ID；执行关联证据采用 UI 输出截图与同一隔离数据库中的 manual execution id `4`。初次新增 custom node 时浏览器还会请求 `/schemas/CUSTOM.blocklyCode/1.0.0.json` 并得到 404；它没有阻断节点编辑或执行，但若后续产品化需要节点 schema/docs，应单独补齐。

## 已知基线问题的归属

- editor-ui full typecheck：未修改的 `packages/frontend/editor-ui/src/features/workflows/canvas/components/elements/nodes/render-types/CanvasNodeDefault.test.ts` 中两个 CSS custom-property TS2353；不归因于 Blockly。
- workflow 标准 TS7 clean build：`execution-cancelled.error.ts` 与 `expression.error.ts` 的两个 `level` TS2353；这是另一项已知基线问题。

两组错误必须分开记录，不能写成 Blockly 测试或 production build 失败。

## 回滚

回滚整个 Blockly MVP 时，停止相关进程后按同一变更集撤销：

1. 取消运行时变量：`unset N8N_CUSTOM_EXTENSIONS`。
2. 从 `pnpm-workspace.yaml` 移除 `custom-nodes/*` workspace 行和 `blockly: 12.3.1` catalog 项。
3. 从 `packages/frontend/editor-ui/package.json` 移除 `"blockly": "catalog:"`。
4. 更新 `pnpm-lock.yaml`，移除 custom node importer、Blockly 及仅由本功能引入的锁文件条目；不要手工删除其他包仍使用的依赖。
5. 从 `packages/workflow/src/interfaces.ts` 的 `EditorType` 移除 `blocklyEditor`。
6. 撤销 `ParameterInput.vue`、`ParameterInput.test.ts` 和 i18n 中的 Blockly 接缝与文本。
7. 移除 `packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor/**`、`custom-nodes/n8n-nodes-blockly-code/**` 和 `scripts/blockly-mvp/**`。
8. 重新执行 `pnpm install` 和受影响包的构建/检查，确认节点创建器不再显示 `Blockly Code`，普通工作流仍可打开。

回滚前保留脱敏验收日志、截图和导出 JSON；不修改历史 workflow JSON 来伪造清理结果。

# Blockly Code MVP 验收

> 当前结论：CLI 技术链路 PASS；浏览器 UI 业务闭环尚未完成，因此不能宣称总体业务 PASS。

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
| editor-ui full typecheck | 基线阻断 | 仅剩未修改的 `CanvasNodeDefault.test.ts` 两处 CSS custom-property TS2353：`--canvas-node--height`、`--canvas-node--width`；不是 Blockly 失败。 |
| workflow 根 TypeScript 6 force build | PASS | workflow ESM/CJS 配置使用根 TS6 `--force` 构建通过。 |
| workflow 标准 TypeScript 7 clean build | 另一已知基线问题 | 曾因 `execution-cancelled.error.ts` 与 `expression.error.ts` 的两个 `level` TS2353 失败；与 Canvas/Blockly 检查分开记录。 |
| 直载节点身份 | PASS | core 常量为 `CUSTOM`，实际节点类型为 `CUSTOM.blocklyCode`。 |
| 全新隔离 DB CLI import | PASS | 无 browser owner setup 即成功导入 1 个 workflow。 |
| 官方 CLI export | PASS | `Successfully exported 1 workflow`；文件为 `scripts/blockly-mvp/.runtime/blockly-code-demo.exported.json`。 |
| 单对象与数组导出 payload 校验 | PASS | `verify-payload.mjs` 对 fixture 单对象和官方单 workflow 数组导出均通过。 |
| CLI task runner execution | PASS | runner 注册，`Blockly Code` status `success`，输出 `{"result":42}`。 |
| 本地实例与 runner | PASS | `http://localhost:5678` 可达，runner ready。 |
| Playwright UI 入口 | 被 owner setup 阻断 | 浏览器进入 `/setup`；截图 `output/playwright/n8n-owner-setup-blocker.png`。 |
| 未认证节点类型端点 | HTTP 401，非 PASS | 只证明请求未认证；不能据此确认节点类型注册或节点创建器可见。 |
| 节点创建器 / Blockly UI / 保存重载 / 浏览器执行 | 待验证 | 为避免输入或记录密码，需用户自行完成 owner setup 后继续。 |

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

CLI 技术链路可以标记 PASS；它不证明节点创建器、Blockly editor、保存重载或浏览器执行已经通过。

## UI 技术验收与业务 PASS

当前实例已经启动且 runner ready，但 Playwright 被重定向到 owner setup 页面：

```text
URL: http://localhost:5678/setup
截图: output/playwright/n8n-owner-setup-blocker.png
```

这张截图只证明 UI setup gate 可见，不证明 Blockly 入口可见。为避免处理密码，自动化未填写 owner 表单。

未认证调用节点类型端点返回 HTTP 401，因此当前不能把该端点标为 PASS；完成 owner setup 后仍需在已认证 UI 中核验节点创建器和参数面板。

用户完成 owner setup 后，以下证据全部齐备才能标记 UI 技术验收和业务 PASS：

1. 节点创建器可搜索并添加 `Blockly Code` 的截图；
2. 参数面板中可操作 Blockly 编辑器的截图；
3. 保存后重载仍显示 return block + `math_number 42` 的截图；
4. n8n 原始导出 workflow JSON，节点类型为 `CUSTOM.blocklyCode` 且包含 `blocklyPayload`；
5. 浏览器执行详情中的 `{"result":42}`；
6. 同一浏览器执行对应的 task runner 日志，包含可关联的时间戳或执行标识。

当前业务 PASS 未完成。测试、production build、CLI import、CLI execution 或 `/setup` 截图均不能单独替代上述可见业务闭环。

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

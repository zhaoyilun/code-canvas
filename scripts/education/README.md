# 教育通用边界检查

`verify-generic-boundary.mjs` 用一条可重复命令确认教育分支仍是领域无关的双画布宿主：

```bash
node scripts/education/verify-generic-boundary.mjs
node --test scripts/education/verify-generic-boundary.test.mjs
```

检查范围严格限定为本项目增加的生产代码、相关 `package.json` 和项目工作流夹具。上游测试、`node_modules`、`dist`、`.pack` 以及用于解释边界的 `docs/education` 不参与文本扫描。

脚本检查五组旧实现已经退出主仓：领域社区节点、领域 Blockly/生成器、硬件 bridge、设备部署、领域交付材料；同时检查生产代码与 manifest 不再引用旧领域契约，并要求项目工作流不再使用 `CUSTOM.*` 临时类型名。真实 Blockly Code 节点的 package/name 契约由节点包自身测试锁定。

## 通用双画布端到端示例

`generic-dual-canvas-example.mjs` 使用已构建的 TypeScript importer、dual-canvas core、
operation SDK 和 data-transform compiler，把纯通用 TypeScript 转换函数生成成可审计的双画布 JSON：

```bash
node scripts/education/generic-dual-canvas-example.mjs
node --test scripts/education/generic-dual-canvas-example.test.mjs
```

输入为 `docs/education/examples/generic-score-normalizer.ts`，确定性输出为
`docs/education/examples/generic-score-normalizer.dual-canvas.json`。验收覆盖
`VisualProgramIRV1`、绑定仓库已有 Blockly Code 节点真实类型的工作流片段、Blockly
payload 编译、完整源码映射、JSON 往返、字节稳定性以及独立的通用运行时依赖闭包。

## 通用代码片段验收矩阵

`generic-snippet-matrix.mjs` 在单一综合示例之外，再用七类基础代码片段逐项验证
字段复制/重命名、数值计算、标量转换、条件分支、数组/对象构造、字段删除和抛错断言：

```bash
node scripts/education/generic-snippet-matrix.mjs
node scripts/education/generic-snippet-matrix.mjs --check
node --test scripts/education/generic-snippet-matrix.test.mjs
```

每个正例都真实经过 TypeScript importer、`VisualProgramIRV1`、n8n workflow、Blockly
payload 编译和 JSON 往返，并对照源码与生成 JavaScript 的运行结果。三个负例锁定 V1
等价语义边界，要求在产物生成前返回带源码位置的诊断。

这里的运行结果对照由 Node.js `node:vm` 完成；真实 n8n 服务与 Task Runner 执行作为
独立运行时验收门，不与基础转换矩阵混写。

样例说明与机器报告分别位于：

- `docs/education/examples/generic-snippet-matrix.md`
- `docs/education/examples/generic-snippet-matrix.report.json`

## 基础代码到真实 n8n Runtime

`numeric-runtime-acceptance.mjs` 把转换矩阵中的 `numeric-calculation.ts` 直接接到真实
n8n Runtime，验证 importer 生成的 IR、Blockly workspace 和 Blockly payload 经 assembly
插入固定输入节点并装配成正式 workflow 后进入
`n8n-nodes-blockly-code.blocklyCode`。其中 Blockly payload 的字符串值与 importer 产物
逐字符一致，未经重编译或改写，并由 internal secure JavaScript Task Runner 输出
`total=52` 与 `pairedItem.item=0`：

```bash
node scripts/education/numeric-runtime-acceptance.mjs --check
node --test scripts/education/numeric-runtime-acceptance.test.mjs
node scripts/education/numeric-runtime-acceptance.mjs
```

运行使用隔离的 `N8N_USER_FOLDER`、n8n `5678` 端口以及自动选择且排除 `8080` 的
Task Broker 端口。完整契约和证据文件说明见
`docs/education/numeric-runtime-acceptance.md`。

## 未知函数到生成模块

`unknown-operation-runtime-acceptance.mjs` 使用 `clampScore/3` 验证完整的模块生成闭环：
首次导入产生 AST 证据和 scaffold request，生成端填写 `implementationRef: null` 的严格 draft，
宿主通过 `finalizeOperationModuleSpecV1` 派生不可变实现身份，再经表达式解释器与测试向量准入
后进入目录。同一源码带目录重导入为携带 `operationRef + implementationRef` 的 `operationCall`
和动态 Blockly 积木，
最后由正式社区节点重新编译并执行：

```bash
node scripts/education/unknown-operation-runtime-acceptance.mjs --check
node --test scripts/education/unknown-operation-runtime-acceptance.test.mjs
node scripts/education/unknown-operation-runtime-acceptance.mjs
```

快速门同时对照 ModuleSpec 解释器、注入函数后的原源码和 Blockly 编译结果；完整门复用
隔离 n8n Runtime，固定使用 `5678`，Task Broker 动态选端口并排除 `8080`。详细契约与证据
清单见 `docs/education/unknown-operation-runtime-acceptance.md`。

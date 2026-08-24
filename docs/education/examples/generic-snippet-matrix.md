# 通用代码片段双画布验收矩阵

这组样例回答一个最基础的问题：一段与具体设备、领域节点无关的代码，是否可以保持原始运行语义，并稳定转换成 n8n 工作流与 Blockly 画布。

每个正例都经过同一条完整链路：

```text
TypeScript 源码
  → TypeScript importer
  → VisualProgramIRV1
  → n8n workflow fragment
  → Blockly payload compile
  → JSON 序列化/反序列化
  → 源码与生成代码运行结果对照
```

除运行结果外，脚本还逐项检查：重复转换字节一致、工作流绑定到仓库已有 Blockly Code 节点的真实类型 `n8n-nodes-blockly-code.blocklyCode`、每个逻辑语句恰好对应一个源码映射、映射引用的 Blockly block 确实存在、`blockRefs` 与工作区中的 block 集合完全一致。节点包自身的单元测试负责锁定其 `description.name` 契约。

本矩阵用 Node.js `node:vm` 对照源码与 Blockly 生成 JavaScript 的结果，验证的是转换、画布编译和语义等价；启动 n8n 服务并经 Task Runner 执行属于单独的运行时验收门。

## 正例

| 样例 | 覆盖能力 | 运行输入组数 |
| --- | --- | ---: |
| `field-copy-rename.ts` | 字段复制、重命名 | 1 |
| `numeric-calculation.ts` | 数值计算 | 1 |
| `scalar-conversion.ts` | 数值、字符串、布尔转换 | 1 |
| `conditional-branch.ts` | 条件分支的 then/else 两条路径 | 2 |
| `array-object-construction.ts` | 数组与对象构造 | 1 |
| `field-delete.ts` | 字段删除 | 1 |
| `throwing-assertion.ts` | 断言成功与抛错两条路径 | 2 |

## V1 等价语义边界负例

负例在任何 IR、工作流或 Blockly 产物产生之前结束，并返回带源码位置的 `SOURCE_SEMANTICS_MISMATCH`：

| 样例 | 被锁定的语义差异 |
| --- | --- |
| `negative-direct-input-read.ts` | 直接读取缺失属性会得到 `undefined`，V1 标准读取会归一化为 `null` |
| `negative-nested-output-write.ts` | V1 嵌套写入会创建并复制父对象，引用语义与直接源码不同 |
| `negative-nullable-number-conversion.ts` | `Number(null)` 与 V1 保留空值的数值转换结果不同 |

## 执行

先构建四个通用包，然后执行矩阵：

```bash
pnpm --filter @n8n/dual-canvas-core build
pnpm --filter @n8n/blockly-data-transform build
pnpm --filter @n8n/dual-canvas-operation-sdk build
pnpm --filter @n8n/dual-canvas-typescript-importer build
node scripts/education/generic-snippet-matrix.mjs
node --test scripts/education/generic-snippet-matrix.test.mjs
```

机器可读结果写入 `docs/education/examples/generic-snippet-matrix.report.json`。`--check` 模式只重跑全部验证并核对该报告的字节稳定性：

```bash
node scripts/education/generic-snippet-matrix.mjs --check
```

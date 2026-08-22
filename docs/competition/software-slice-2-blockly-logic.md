# 比赛软件切片 2：n8n 节点内 Blockly Logic

## 1. 目标

本切片把产品边界落实为：

- n8n 是唯一宏观工作流画布；
- Blockly 只出现在需要展开内部逻辑的 n8n 节点中；
- `Blockly Logic` 承担通常由 Code 节点处理的局部确定性数据逻辑；
- `Robot Plan` 承担一个机器人子任务内部的技能、原语、参数、短等待与局部条件；
- RoboFrame 继续承担实时能力目录、安全校验、状态、执行与取消。

一句话定位：**n8n 搭系统，Blockly 展开代码细节，AI 生成两层图，RoboFrame 执行机器人动作。**

## 2. 模块选择规则

| 问题类型 | 归属 |
| --- | --- |
| Webhook、定时、审批、通知、长等待、跨系统分支 | n8n 原生节点 |
| 单个 item 内的字段、数学、文本、数组、对象与局部条件 | Blockly Logic |
| 新外部系统、协议、设备或凭据能力 | n8n 自定义节点 |
| 机器人内部详细动作序列 | Blockly Robot Plan |
| 机器人能力、安全、状态、运动与取消 | RoboFrame |

只要 n8n 已有成熟节点，生成器直接使用该节点。Blockly Logic 聚焦原本会落入
JavaScript Code 节点的局部纯逻辑，避免复制 HTTP、数据库、凭据和工作流调度能力。

## 3. 节点内界面

`Blockly Logic` 与 `Robot Plan` 都通过 n8n NDV 参数编辑器打开：

```text
n8n workflow canvas
  └─ selected node
      ├─ Blocks: real Blockly renderer and toolbox
      ├─ Generated JavaScript or compiled RobotTaskPlan (read-only)
      └─ Teaching annotation for the selected AI-generated block
```

编辑器明确显示 `Inside this n8n node`。宽面板采用左右双栏，左侧为真实 Blockly
拼图，右侧为确定性生成结果；窄面板自动切换为上下布局。AI 生成的 Logic statement
以及 Robot action/guard block 都在标准 `data` 字段保存：

```json
{
  "intentStepId": "logic.normalize.amount",
  "teaching": {
    "what": "把输入金额转换为数字",
    "why": "下游判断需要稳定数值类型",
    "editable": ["输入路径", "输出字段"],
    "expectedEffect": "normalizedAmount 是数字或 null"
  }
}
```

用户选中该积木后，界面显示“做什么、为什么、可修改项、预期效果”。

## 4. Blockly Logic 语法

### 4.1 Statement

- set output field；
- delete output field；
- bounded IF/ELSE；
- assertion with a generated message。

### 4.2 Value

- input field and path read；
- text / number / boolean；
- arithmetic, comparison, AND/OR/NOT and conditional value；
- text join；
- text / number / boolean conversion；
- official Blockly list creation and length；
- array index, path projection and path filter；
- object creation and property chain。

数组创建复用 Blockly 官方 `lists_create_with` mutator。`extraState.itemCount` 与可见
槽位一致；空槽按官方生成器习惯编译为 `null`。

执行边界保持纯数据、同步、一进一出。workspace 是唯一执行真相；保存的 JavaScript
只是只读预览，节点运行时使用共享编译器重新生成代码后交给 n8n task runner。

## 5. AI 统一设计稿 v2

生成入口只接受严格 `schemaVersion: "2.0"`，并要求 `logicNodes` 数组存在：

```json
{
  "schemaVersion": "2.0",
  "designId": "lesson.inspect",
  "revisionId": "revision-2",
  "name": "AI 可解释机器人课程",
  "logicNodes": [
    {
      "nodeRef": "logic.normalize-input",
      "label": "规范化课程输入",
      "outputMode": "copyInput",
      "statements": [
        {
          "kind": "set",
          "intentStepId": "logic.normalize.amount",
          "targetField": "normalizedAmount",
          "value": {
            "kind": "convert",
            "to": "number",
            "value": { "kind": "input", "path": "amount" }
          }
        }
      ]
    }
  ],
  "robotPlan": {}
}
```

AI 只生成受 schema 约束的语义结构。确定性生成器负责输出：

- n8n workflow JSON；
- 每个 `CUSTOM.blocklyCode` 的 schema-2 payload；
- `CUSTOM.robotSkillPlan` 的 catalog-bound payload v2；
- RobotTaskPlan；
- normalized semantic draft；
- cross-surface trace map。

## 6. 生成的主链

```text
Manual Trigger
  → Blockly Logic 0..n
  → Robot Status
  → Robot Ready?
    ├→ Robot Plan
    │  → Robot Validate
    │  → Human Approval
    │  → Merge validated plan + decision
    │  → Robot Task
    │  → Completed / Needs Inspection
    └→ Robot Not Ready

Approval false → Rejected
```

策略校验要求局部逻辑使用 `CUSTOM.blocklyCode`，并检查其中 payload 可被共享编译器
重新编译。普通 Code 节点不会出现在 Competition Designer 生成的图中。

`Robot Status` 在加入实时机器人状态时保留上游业务字段，因此 Blockly Logic 生成的
课程数据会继续进入计划、校验、审批和执行链；同名机器人状态字段以实时查询结果为准。

## 7. 追踪关系

Logic：

```text
logicNodeRef + intentStepId → n8nNodeId → blockId
```

Robot：

```text
planRef + intentStepId → n8nNodeId → blockId → planStepId → runtimeTaskId
```

这些稳定 ID 支持从 AI 解释跳到 n8n 节点、定位 Blockly 积木，并在执行结果中回看
对应机器人步骤。

## 8. 本切片验收

- Blockly Logic shared compiler：30 tests；
- Blockly Logic custom node：18 tests；
- Blockly Robot Plan shared compiler/generator：36 tests；
- Competition Designer：38 tests；
- RoboFrame custom nodes：48 tests；
- Blockly editor targeted suite：15 tests；
- 相关包的 typecheck、lint 与 build 均纳入最终集成复跑。

可直接导入的生成结果位于 `docs/competition/fixtures/workflow-v2.json`。对应严格设计稿、
Blockly Logic/RobotTaskPlan/trace 摘要以及确定性再生成脚本位于同一 fixtures 目录和
`scripts/competition/generate-software-slice-2-demo.mjs`。

早期 schema-1 `blockly-mvp` 演示和校验脚本已退出仓库；当前演示、导入与验收统一使用
schema 2，避免旧脚本对已失效载荷给出误判结果。

硬件阶段继续使用同一接口，把 live RK3588/RoboFrame catalog、真实任务状态和设备执行
证据接入现有生成、校验、审批与追踪链。

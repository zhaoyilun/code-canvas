# 比赛软件切片一：双图生成与受审查执行基线

> 文档状态：当前实现说明，不替代 `design-v1.md`
> 分支：`codex/competition-blockly-robot-framework-n8n`
> n8n-blockly 基线：`cd13e77691943e501b4978dfaa2e28be9684b021` 加本分支工作区实现
> RoboFrame 对照基线：`HEAD a2592f`
> 日期：2026-08-22

## 1. 这个软件切片已经解决什么

第一软件切片把“AI 生成机器人低代码方案”收敛成一条确定性链路：

1. 上游 AI 或教学应用提交一份受限的结构化设计草稿；
2. `Competition Design` 从 RoboFrame Bridge 读取当前 catalog 和 named poses；
3. 同一份草稿生成两张互相关联的图：
   - n8n 宏观编排图；
   - Blockly 机器人详细计划图；
4. Blockly 图立刻用生成时的 catalog 回编译并校验语义；
5. 生成结果保留 AI 意图、Blockly block、派生计划步骤和 n8n 节点之间的稳定映射；
6. 候选 n8n 图包含状态检查、计划编译、整计划校验、人工审核、执行和结果分流；
7. 工作流保持 `review_required`，生成动作本身不发布工作流，也不触发机器人运动。

这证明了双图的核心数据契约和最小软件链路。自然语言模型调用、真实 n8n 导入、浏览器完整交互和 RK3588 实机运行仍属于后续验收门。

## 2. 三层职责结论

### 2.1 n8n 是主体

n8n 负责跨系统、跨时间、需要审核和留痕的宏观流程：

- Manual、Webhook、Chat、Form、Schedule 等入口；
- AI Agent、模型、工具和结构化输出；
- 状态检查、IF、Merge、Wait/Form、人工批准或驳回；
- 外部 API、数据库、通知、凭据和执行历史；
- 工作流保存、版本、导入、发布和运行结果分支；
- RoboFrame 计划的编译、校验和执行节点编排。

本切片生成的 n8n 候选图有 14 个节点，主链如下：

```text
01 Start
  → 02 Robot Status
  → 03 Robot Ready?
      ├─ false → 14 Robot Not Ready
      └─ true
          → 04 Robot Plan（Blockly payload 回编译）
          → 05 Validate Plan
          → 06 Human Approval
          → 07 Approved?
              ├─ false → 13 Rejected
              └─ true → 08 Merge Approved Plan
                           → 09 Execute Robot Plan
                           → 10 Task Completed?
                               ├─ true → 11 Completed
                               └─ false → 12 Needs Inspection
```

状态、校验结果和审批表单在 Merge 节点重新汇合，避免审批表单数据覆盖已经校验的计划。

### 2.2 Blockly 是 n8n 的机器人细节补充

Blockly 只表达一次机器人任务内部的短序列：

- catalog 中存在的 skill；
- catalog 中存在并带明确 schema 的 primitive；
- named pose；
- 技能和 primitive 参数；
- 最长 60 秒的局部等待；
- 基于 `last.success` 或 `last.state` 的相邻步骤守卫。

以下内容继续由 n8n 表达：

- 长等待和人工审批；
- 跨任务、跨机器人或跨外部系统的 IF、Switch、Loop、Merge；
- Webhook、表单、通知、数据库、凭据和错误工作流；
- 发布、版本、重试策略和执行历史。

因此，Blockly 不是第二套 n8n。它是 Robot Skill Plan 节点的可视化详细设计器，让学员看到“这个宏观节点内部具体调用哪些机器人能力、参数为何这样设置”。

### 2.3 RoboFrame 是能力、安全和真实执行边界

RoboFrame 及其 Gateway 决定：

- 机器人当前公开哪些 skills、primitives 和 named poses；
- 参数 schema、默认超时和恢复策略；
- motion authorization、控制模式、busy 和 readiness；
- 动作是否通过运行前校验；
- 任务是否实际执行、取消以及最终状态。

HTTP Bridge 只承担协议适配和短期任务状态：

- 把 n8n 的 `{ kind, name, params, context }` 转为 RoboFrame CLI 调用；
- 在启动后台线程前登记 `accepted`；
- 保存 `accepted → running → terminal` 状态；
- 提供查询、重复 task ID 冲突和取消确认；
- 保留 `blockId`、`planStepId`、workflow 和节点上下文。

Bridge 未暴露运动授权开关，也不替代 RoboFrame 的安全裁决。

## 3. 四份数据的真相关系

| 数据 | 角色 | 是否可编辑 | 使用时机 |
| --- | --- | --- | --- |
| n8n `WorkflowJSON` | 宏观编排真相 | 是 | 保存、导入、审核、发布和执行 |
| Blockly payload v2 | 机器人详细计划真相 | 是，其中 workspace 可视化编辑 | Robot Skill Plan 保存和导入 |
| `RobotTaskPlan` | 从 workspace 派生的执行产物 | 否 | 校验和 Robot Task 执行 |
| `traceMap` | 教学定位与运行追踪映射 | 随生成结果重建 | 双向高亮、解释和复盘 |

Blockly payload v2 只有一个格式：

```json
{
  "schemaVersion": 2,
  "catalog": {
    "robotName": "ROBOT_NAME",
    "configDigest": "LIVE_DIGEST",
    "skills": [],
    "primitives": [],
    "namedPoses": []
  },
  "workspace": {
    "blocks": {
      "blocks": []
    }
  }
}
```

旧 payload、独立 plan preview 和二参数 serializer 已退出主路径。运行时从 payload 取出同一份 catalog 和 workspace 重新编译，避免“编辑器看一份目录、执行器按另一份固定快照解释”的漂移。

正式能力以 live catalog 为准：

1. 设计时从 Bridge 读取 live catalog 和 named poses；
2. payload 固定这次设计所用的 catalog 与 `configDigest`；
3. 导入和重新打开时，编辑器仍按 payload catalog 注册积木并回编译；
4. 执行前再次读取 live catalog；
5. live digest 与计划 digest 不同则停止在执行前，要求重新生成或重新审查。

内置 SO-101 snapshot 只用于新建节点的默认示例和软件 fixture，不代表设备当前能力。

## 4. AI 到双图的真实数据流

### 4.1 当前入口边界

当前切片从结构化 `CompetitionDesignDraft` 开始。它不是任意 n8n JSON，也不是任意 Blockly JSON：

```text
CompetitionDesignDraft
  ├─ designId / revisionId / name
  └─ robotPlan: RobotPlanDraft
       ├─ planRef / robotProfileRef / catalogDigest / budgetSec
       └─ steps[]
            ├─ stepRef
            ├─ kind: skill | primitive | namedPose | wait
            ├─ catalog capability name and params
            ├─ optional when
            └─ optional teaching: what / why / editable / expectedEffect
```

自然语言模型接入层需要把学员输入转成这个结构。该模型接入、提示词、模型凭据和一次受限修订还未进入本切片；当前单元测试直接提供结构化草稿。

### 4.2 生成阶段

```text
学员自然语言（后续接入）
  → AI 结构化 CompetitionDesignDraft
  → Competition Design 节点
      ├─ GET live catalog
      ├─ GET named poses
      └─ mapBridgeCatalog
  → @n8n/competition-designer
      ├─ Zod 严格校验设计草稿
      ├─ @n8n/blockly-robot-skills 生成 Blockly workspace
      │    ├─ 只选择 catalog 中的能力
      │    ├─ 校验参数 schema、预算、超时和引用
      │    ├─ 生成稳定 blockId / planStepId
      │    ├─ workspace → RobotTaskPlan 回编译
      │    └─ 规范化语义等价检查
      ├─ payload v2 封装 catalog + workspace
      ├─ @n8n/workflow-sdk 生成 n8n WorkflowJSON
      ├─ competition workflow policy 校验审核和执行路径
      └─ 合并 traceMap
  → 候选 artifact
```

成功 artifact 同时包含：

- `n8nWorkflow`；
- `blocklyPayload`；
- `blocklyWorkspace`；
- 规范化 `semanticDraft`；
- 派生 `robotTaskPlan`；
- `traceMap`；
- `catalogDigest`。

生成失败按阶段返回结构化诊断：`design-draft`、`robot-plan`、`workflow-policy` 或节点侧的 `live-catalog`、`target-credential`、`generation`。

### 4.3 稳定映射

每个可执行意图步骤形成：

```text
intentStepId / stepRef
  ↔ blockId
  ↔ planStepId = "step:" + blockId
  ↔ n8nPlanNodeId
  ↔ n8nExecutionNodeId
```

`blockId` 由 `designId + planRef + stepRef` 确定性生成。改变参数或调整顺序时，同一语义步骤仍可被教学界面定位；更换 `stepRef` 表示一个新的教学步骤。

### 4.4 导入后的编辑与运行

```text
n8n 导入候选 WorkflowJSON（待真实实例验收）
  → Robot Skill Plan 打开 Blockly payload
  → 编辑器按 payload.catalog 注册 skill / primitive 控件
  → 学员修改 blocks 和 PARAMS_JSON
  → 保存 catalog + workspace
  → Robot Skill Plan 运行时重新编译
  → Robot Validate 校验整个计划并核对 live digest
  → Wait/Form 人工审核
  → Robot Task 顺序执行
  → Bridge → RoboFrame
  → steps[] 返回 blockId / planStepId / taskId / state
  → n8n 完成或检查分支
```

`Robot Skill Plan` 只有 compile 职责。机器人动作统一由 `Robot Task` 执行，避免编辑器节点和执行节点各自形成一条执行语义。

## 5. 已有、欠缺和重复模块裁决

### 5.1 当前已有

| 模块 | 当前实现 | 本切片裁决 |
| --- | --- | --- |
| n8n Workflow SDK 生成 | 生成 14 节点候选图、连接、布局、稳定 ID 和 meta | 作为 n8n 图唯一生成层 |
| Competition workflow policy | 精确检查 readiness/approval 条件语义，并检查计划校验、驳回、结果分支、凭据和直接 HTTP 禁令 | 作为项目级确定性守门器 |
| Competition Design 节点 | 读取 live catalog/poses，消费结构化草稿，输出双图和映射 | 属于设计工具流程，不进入生成后的业务工作流 |
| RobotPlanDraft 生成器 | 受限草稿到 Blockly workspace、稳定 ID、source map、回编译和语义等价 | 作为 AI 到 Blockly 的唯一入口 |
| Robot 编译器 | 严格 workspace 到 `RobotTaskPlan`；拒绝空计划、未知 input、隐藏链和重复 ID | 作为执行计划唯一派生层 |
| Payload v2 | catalog 与 workspace 同存、严格解析和 UTF-8 大小限制 | 作为唯一持久化格式 |
| Robot Blockly 编辑器适配 | 按 payload catalog 注册和编译，保留 `PARAMS_JSON` | 作为 Robot Skill Plan 参数编辑器 |
| RoboFrame 节点族 | Catalog、完整 Gateway Status、Skill、Skill Plan、Validate、Task、Competition Design | 作为 n8n 与 Bridge 的受限适配层 |
| Robot Task engine | 校验 planDigest 后顺序执行、skipIf、wait、超时取消、完整步骤结果和映射上下文 | 作为计划唯一执行入口 |
| HTTP Bridge | action kind、catalog、status、validate、execute、task query/cancel、状态内存 | 作为 RoboFrame 协议适配层 |

### 5.2 当前欠缺

| 缺口 | 对当前结论的影响 | 下一门 |
| --- | --- | --- |
| 自然语言模型到 `CompetitionDesignDraft` | 当前证明结构化草稿后的生成链，尚未证明真实提示词生成 | 接入模型、结构化输出和提示词回归 |
| 真实 n8n 实例导入 | 当前证明 JSON 和策略，尚未证明目标实例无 missing node 并可保存重载 | 完整 checkout 构建后做 UI/API 导入 |
| 双画布下钻、diff、教学解释面板、逐块回放 | 当前已有数据和映射，完整教学交互尚待实现 | 浏览器 E2E |
| 真实 Bridge 在线连接 | 节点和 Bridge 由 mock/契约测试覆盖，网络、鉴权和进程部署尚待验 | 本机 HTTP 再到 RK3588 |
| RoboFrame `a2592f` primitive 公共 CLI | 当前 upstream 基线尚未给出已确认的 primitive 公共 CLI 路径 | 硬件阶段按 live catalog 选择执行路线 |
| RK3588/OpenHarmony/机器人动作 | 当前没有 device 证据 | 硬件输入冻结后分级验收 |
| 导出证据包和哈希 | artifact 字段已具备，完整 bundle 生成器尚待实现 | 软件验收后续切片 |

### 5.3 重复功能的最终归属

| 重复风险 | 裁决 |
| --- | --- |
| n8n IF/Loop 与 Blockly 控制块 | 宏观控制全部留在 n8n；Blockly 仅保留相邻步骤守卫和短等待 |
| n8n Edit Fields/Code 与 Blockly Data Transform | 通用数据处理优先 n8n；Data Transform 只作为数据逻辑教学模式 |
| Robot Skill Plan execute 与 Robot Task | Skill Plan 只编译，Robot Task 唯一执行 |
| payload 中 workspace 与 plan preview | workspace 是真相，plan 每次回编译；preview 字段退出 payload |
| 固定 snapshot 与 live catalog | snapshot 是 fixture；正式生成和执行以 live catalog 为准 |
| 自研 HTTP Request 调机器人与 RoboFrame 节点 | 机器人动作只走带凭据和 kind 约束的节点；生成策略拒绝直接动作 HTTP |
| Bridge 安全判断与 RoboFrame Gateway | Bridge 只转协议；授权和运动安全由 RoboFrame 裁决 |
| AI 直接拼两张图与确定性生成器 | AI 只给受限语义草稿；两个生成器负责实际图结构和校验 |

## 6. Primitive 路线的当前事实

本切片在内部契约中完整保留 `kind: skill | primitive`，通用 HTTP action 端点按 kind 查询对应目录。这证明的是软件分派不会把 primitive 当成 skill。

对照 RoboFrame `HEAD a2592f`，当前尚未确认面向本 Bridge 的 primitive 公共 CLI 和公开 catalog 路径。真实 CLI provider 因而返回空 `primitives[]`，且不会构造虚拟 primitive 命令；Fake provider 中的 primitive 成功仅用于验证 REST/TypeScript kind 契约。

硬件阶段按 live catalog 和目标设备上的 CLI 探针选择一条路线：

1. 目标 RoboFrame 版本已公开 primitive catalog 与公共 CLI：Bridge 直接适配；
2. RoboFrame 提供其他稳定公共接口：Bridge 适配该接口并保持 REST action 契约不变；
3. 目标版本只公开 skills：live catalog 的 `primitives[]` 保持为空，本阶段课程不生成 primitive；
4. 需要扩展 RoboFrame：先冻结 upstream 变更和版本，再进入设备验收。

路线选择前，软件 mock 中的 primitive 成功只记为契约证据。

## 7. 关键文件

### 双图设计与策略

- `packages/@n8n/competition-designer/src/contracts.ts`
- `packages/@n8n/competition-designer/src/design-generator.ts`
- `packages/@n8n/competition-designer/src/workflow-generator.ts`
- `packages/@n8n/competition-designer/src/workflow-policy.ts`
- `packages/@n8n/competition-designer/src/stable-ids.ts`
- `packages/@n8n/competition-designer/README.md`

### Blockly 机器人计划

- `packages/@n8n/blockly-robot-skills/src/catalog.ts`
- `packages/@n8n/blockly-robot-skills/src/generator.ts`
- `packages/@n8n/blockly-robot-skills/src/compiler.ts`
- `packages/@n8n/blockly-robot-skills/src/payload.ts`
- `packages/@n8n/blockly-robot-skills/README.md`

### 编辑器

- `packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor/BlocklyEditor.vue`
- `packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor/robotSkills.ts`
- `packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor/robotSkills.test.ts`
- `packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor/BlocklyEditor.test.ts`

### n8n RoboFrame 节点

- `custom-nodes/n8n-nodes-roboframe/nodes/CompetitionDesign/CompetitionDesign.node.ts`
- `custom-nodes/n8n-nodes-roboframe/nodes/CompetitionDesign/catalog.ts`
- `custom-nodes/n8n-nodes-roboframe/nodes/RobotSkillPlan/RobotSkillPlan.node.ts`
- `custom-nodes/n8n-nodes-roboframe/nodes/RobotValidate/RobotValidate.node.ts`
- `custom-nodes/n8n-nodes-roboframe/nodes/RobotTask/RobotTask.node.ts`
- `custom-nodes/n8n-nodes-roboframe/nodes/shared/engine.ts`
- `custom-nodes/n8n-nodes-roboframe/nodes/shared/bridge.ts`
- `custom-nodes/n8n-nodes-roboframe/README.md`

### RoboFrame HTTP Bridge

- `services/roboframe-bridge/roboframe_bridge/app.py`
- `services/roboframe-bridge/roboframe_bridge/client.py`
- `services/roboframe-bridge/roboframe_bridge/memory.py`
- `services/roboframe-bridge/roboframe_bridge/models.py`
- `services/roboframe-bridge/tests/test_app.py`
- `services/roboframe-bridge/README.md`

## 8. 本切片支持的结论

当前代码支持以下结论：

> n8n 作为宏观主体，已经能把一份受限的机器人设计草稿确定性转换为带状态门、整计划校验、人工审核和结果分流的候选 n8n 图；Blockly 作为 Robot Skill Plan 的细节补充，已经能按同一份 live-catalog 快照生成、保存、重新加载和回编译机器人计划；RoboFrame 仍保持能力、安全和实际执行的最终边界。

当前代码尚未形成以下证据：真实模型从自然语言生成、目标 n8n 实例导入、真实浏览器完整交互、RK3588 上的 Bridge/RoboFrame 运行、primitive 公共 CLI、机器人实际动作和教学成效。

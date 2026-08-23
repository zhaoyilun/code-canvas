# AI 可解释机器人课堂：完整中文演示案例

本目录提供一套可直接导入 n8n 的比赛演示资产。它把 AI 的受约束设计草稿同时生成为：

- **n8n 宏观工作流**：输入、Blockly 逻辑、设备状态、校验、教师确认、执行和回看；
- **Blockly Logic 工作区**：处理课堂数据，不使用普通 Code 节点；
- **Blockly Robot Plan 工作区**：生成受约束的 `RobotTaskPlan`，交由 RoboFrame 节点校验和执行；
- **完整中文讲稿**：见 [DEMO_SCRIPT.md](./DEMO_SCRIPT.md)。

## 文件

| 文件 | 用途 |
| --- | --- |
| `ai-explainable-robot-classroom.workflow.json` | 导入本地 n8n 的完整工作流，默认未激活。 |
| `ai-explainable-robot-classroom.design-draft.json` | AI 生成前的受约束语义草稿。 |
| `ai-explainable-robot-classroom.artifact-summary.json` | 生成得到的 Blockly payload、RobotTaskPlan 与教学 trace。 |
| `initial-classroom-input.json` | `02 准备课堂输入` 节点写入的确定性示例数据。 |
| `expected-blockly-output.json` | 两个 Blockly Logic 节点完成后的预期数据。 |
| `DEMO_SCRIPT.md` | 面向老师与评委的中文演示脚本。 |

## 生成

首次生成前，需要构建这两个现有包：

```powershell
pnpm --filter @n8n/blockly-data-transform build > $env:TEMP\blockly-data-transform-build.log 2>&1
pnpm --filter @n8n/blockly-robot-skills build > $env:TEMP\blockly-robot-skills-build.log 2>&1
pnpm --filter @n8n/competition-designer build > $env:TEMP\competition-designer-build.log 2>&1
node scripts/competition/generate-ai-explainable-robot-classroom-demo.mjs
```

生成器会先让 `@n8n/competition-designer` 对两张 Blockly 图和 n8n 宏观图进行一致性校验，再写出上述 JSON 文件。

## 导入到本地 n8n

1. 打开本地 n8n，例如 `http://localhost:5678`。
2. 在 **Workflows** 中选择 **Import from File**。
3. 选择 `ai-explainable-robot-classroom.workflow.json`。
4. 导入后先查看 `02 准备课堂输入`、两个 Blockly 节点和 `07 Blockly · 生成机器人计划`；工作流默认未激活。
5. 需要联接 RoboFrame 时，在三个 RoboFrame 节点中绑定目标实例已保存的 **RoboFrame Bridge API** 凭据。

## 设备边界

导入、查看 Blockly、生成计划与讲解预期输出不触发机器人动作。进入 RoboFrame 动作链需同时满足：

1. 目标 n8n 已绑定 RoboFrame Bridge 凭据；
2. `05 RoboFrame · 查询设备状态` 返回 `motionAuthorized=true` 且 `busy=false`；
3. `08 RoboFrame · 校验机器人计划` 接受当前计划与 live catalog digest；
4. 教师在 `09 教师确认（表单）` 选择 **批准**；
5. 设备操作员已按现场流程完成运动授权。

`07 Blockly · 生成机器人计划` 只编译 `RobotTaskPlan`；真正提交到 RoboFrame 的节点是 `12 RoboFrame · 执行计划`。

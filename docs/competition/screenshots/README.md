# RoboTeach Studio 老师展示截图

截图时间：2026-08-23。截图来自本机运行的真实 n8n 前端 `http://localhost:8080`，对应比赛分支的 Blockly 与 RoboFrame 自定义节点；`127.0.0.1:8765` 的独立展示页未用于本组截图。`01` 至 `03` 已按当前中文界面与 `1965 × 1272` 屏幕重新采集。

| 文件 | 展示重点 | 老师讲解口径 |
| --- | --- | --- |
| `01-workflow-overview.png` | 真实 n8n 工作流画布、RoboTeach 任务条、Blockly 与机器人节点语义色 | n8n 负责全局流程；紫色节点展开代码逻辑，橙色节点组织机器人能力。 |
| `02-blockly-logic-workbench.png` | 真 Blockly 工具箱、积木工作区与只读 JavaScript | 学员用拼图理解数据处理代码，积木保存后由 n8n 重新编译并执行。 |
| `03-robot-plan-workbench.png` | Robot Plan Blockly、RoboFrame 动作编排与编译后的任务计划 | 课程任务计划带有 `rk3588_training_arm` 配置标识；动作先转为结构化计划，再进入校验和执行流程。 |
| `04-real-execution-success.png` | n8n Execution 成功记录、三步运行轨迹和真实输出 | 这条路径已经实跑成功：输入成绩 85，经 Blockly 逻辑得到统一分数 102，并输出活跃学员数据。 |

展示顺序建议：先展示全局工作流，再打开 Blockly Logic 与 Robot Plan，最后展示执行记录。这样可以完整讲清“AI 给出思路 → 学员看懂并修改积木 → n8n 编排 → RoboFrame 校验/执行 → 回看结果”的闭环。

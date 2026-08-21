# Phase 2 验收记录 — Blockly 侧（技能计划编辑器）

> 分支 `feat/roboframe-integration`。对照设计稿 §10 Phase 2 与 §11 测试矩阵。

## 交付物

| 组件 | 路径 | 状态 |
| --- | --- | --- |
| 共享编译器 | `packages/@n8n/blockly-robot-skills/`（语法白名单、结构化计划编译、payload schema 1、限制表、SO-101 离线快照） | ✅ 已实现 |
| EditorType | `packages/workflow/src/interfaces.ts` 新增 `'robotSkillEditor'` | ✅ 已实现 |
| 编辑器分发 | `ParameterInput.vue` 两处（弹窗+内联）分发 `robotSkillEditor` → `BlocklyEditor editorMode="robot-skills"` | ✅ 已实现 |
| 积木语法 | `BlocklyEditor/robotSkills.ts`（6 种 robot 块 + math_number/text；无变量/循环） | ✅ 已实现 |
| i18n | `@n8n/i18n` en.json 新增 26 个 `robotSkillEditor.*` key | ✅ 已实现 |
| Robot Skill Plan 节点 | `CUSTOM.robotSkillPlan`（compile/execute 双模式、后端重编译、digest 校验） | ✅ 已实现 |
| Robot Task 节点 | `CUSTOM.robotTask`（顺序执行、首败即停、摘要输出） | ✅ 已实现 |

## 自动化验证（本机可复跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 共享编译器（24 例：默认工作区确定性、参数 schema、未知技能/primitive、危险 key、方向/超时/JSON 校验、skipIf 守卫、wait 边界、预算 180s、深度、payload 往返/伪造 schemaVersion/超限、extractPlan） | `cd packages/@n8n/blockly-robot-skills && pnpm vitest run` | 24 passed |
| 节点包（17 例，含 plan 字段篡改无效果——workspace 是唯一真相） | `cd custom-nodes/n8n-nodes-roboframe && pnpm vitest run nodes` | 17 passed |
| 编辑器（7 例：工具箱只含白名单语法、robot 块注册、默认工作区加载编译、方向+距离参数编译、无效工作区保存空预览） | `cd packages/frontend/editor-ui && pnpm vitest run src/features/shared/editors/components/BlocklyEditor/` | 7 passed |
| v1 编辑器回归（`blocklyEditor` 分发 56 例 + v1 payload 3 例不受 `editorMode` 影响） | `pnpm vitest run src/features/ndv/parameters/components/ParameterInput.test.ts` | 56 passed |
| typecheck | editor-ui `pnpm typecheck` | 我方变更 0 错误（仅余 2 个基线预存 `CanvasNodeDefault.test.ts` 错误，源自 n8n 2.35.4 快照，与本分支无关） |
| editor-ui 生产构建 | `pnpm build` | 通过（见 build log） |

## 设计符合性

- ✅ 结构化计划而非 JavaScript：编译产物为 `RobotTaskPlan`（schemaVersion 1，含 `configDigest`）。
- ✅ workspace 唯一真相 + 后端重编译：`RobotSkillPlan` 忽略 payload.plan，执行前重编译（防篡改测试覆盖）。
- ✅ 步级 `skipIf` 守卫、plan 保持线性（审核已决 #6）。
- ✅ 计划时效：payload 记录 `configDigest`，执行期与 bridge 实时 catalog 比对，不一致报"计划已过期"。
- ✅ 总预算：所有步骤 timeout+wait ≤ `task_budget_sec`（180s）。
- ✅ v1 不受影响：`blockly-data-transform` 包零改动；`BlocklyEditor.vue` 默认 mode 走原路径；v1 全部测试通过。
- ✅ 不做通用 SDK：新语法独立成包，仅共享 `BlocklyEditor.vue` 组件（`editorMode` prop）。

## 未覆盖（按设计留待后续）

- ⏭ 浏览器内真实拖拽 E2E（Playwright）：需运行完整 n8n 实例 + bridge，仿真环境验收时执行。
- ⏭ live catalog 动态下拉：v2 范围（审核已决 #5），当前为节点包离线快照。

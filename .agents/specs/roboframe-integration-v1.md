# RoboFrame Integration v1

## Entry card

| Field | Decision |
| --- | --- |
| Project root | `/Volumes/MySSD/zhaoyilun/dev/n8n-blockly` |
| Base | n8n `2.35.4`, Blockly `12.3.1`, blockly-data-transform v1（`70c66ad1`） |
| Branch | `feat/roboframe-integration` |
| Design | `docs/roboframe/roboframe-integration-design.md` v0.2（15 条审核意见已落入） |
| Upstream | https://gitcode.com/openeuler/IB_Robot `RoboFrame` 分支（commit `8f364c3`，只读消费） |
| Delivery | n8n 节点族 + HTTP bridge + Blockly 技能计划编辑器；roboframe 执行层零改动 |
| Product | `Robot Catalog` / `Robot Status` / `Robot Skill` / `Robot Validate` / `Robot Task` / `Robot Skill Plan`（`CUSTOM.*` 直载前缀） |

## Scope snapshot

- Phase 1（已完成，代码级验收见 `docs/roboframe/phase1-acceptance.md`）：`services/roboframe-bridge/`（FastAPI、Bearer token、近无状态、任务终态内存登记）+ `custom-nodes/n8n-nodes-roboframe/`（凭据 + 5 节点 + 引擎）。
- Phase 2（已完成，见 `docs/roboframe/phase2-acceptance.md`）：`packages/@n8n/blockly-robot-skills/`（编译器 + payload schema 1 + SO-101 离线快照）、`EditorType` 新增 `robotSkillEditor`、`BlocklyEditor.vue` `editorMode` prop、i18n、`robotSkillPlan`/`robotTask` 节点。
- Phase 3（未开始，按设计 §10）：状态边沿触发、感知条件块、rule_entry 可视化、ML 数据闭环、OpenClaw 集成、实机验收。

## Invariants（实施与后续改动必须保持）

1. 所有动作只经 bridge → `robot-skill` → `/embodied/execute_skill` → `safety_guard`；任何节点/积木不得直连 ros2_control/MoveIt/`/task_executor/*`。
2. 无 `authorize_motion` 入口；未授权时明确报错。
3. 失败/超时不自动重试；取消后 `state=unknown` 不得表述为"已停止"。
4. workspace 是唯一真相：运行期忽略 payload.plan，一律重编译。
5. 参数经 `capability.parameters` schema 校验（编译期 + bridge + Gateway 三层）。
6. 计划携带 `configDigest`；执行期与实时 catalog 比对。
7. plan 总预算 ≤ `task_budget_sec`（180s）；步数 ≤ 100。
8. 危险 key（`__proto__`/`prototype`/`constructor`）与超限一律编译失败。
9. `blockly-data-transform` v1 包与 `blocklyEditor` 行为零改动（回归测试守护）。
10. token 只存 n8n 凭据库；日志/执行记录脱敏。

## Intended files

```text
services/roboframe-bridge/**
custom-nodes/n8n-nodes-roboframe/**
packages/@n8n/blockly-robot-skills/**
packages/workflow/src/interfaces.ts          # EditorType + 'robotSkillEditor'
packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor/**
packages/frontend/editor-ui/src/features/ndv/parameters/components/ParameterInput.vue
packages/frontend/@n8n/i18n/src/locales/en.json
docs/roboframe/**
.agents/specs/roboframe-integration-v1.md
```

禁止：数据库迁移、新 REST 端点、新 runner、修改 roboframe 上游执行层、通用 Blockly SDK。

## Verification commands

```bash
cd services/roboframe-bridge && python -m pytest -q
cd packages/@n8n/blockly-robot-skills && pnpm vitest run && pnpm typecheck && pnpm lint
cd custom-nodes/n8n-nodes-roboframe && pnpm vitest run nodes && pnpm typecheck && pnpm lint && pnpm build
cd packages/frontend/editor-ui && pnpm vitest run src/features/shared/editors/components/BlocklyEditor/ src/features/ndv/parameters/components/ParameterInput.test.ts
```

剩余验收（需 ROS/仿真环境，见两份 acceptance 的"未覆盖"节）：单技能链路端到端、`robot-skill --json` 映射联调、浏览器拖拽 E2E。

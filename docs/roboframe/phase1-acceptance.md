# Phase 1 验收记录 — n8n 侧 MVP（bridge + 节点族）

> 分支 `main`（开发分支 `feat/roboframe-integration` 已并入）。对照设计稿 §10 Phase 1 与 §11 测试矩阵。
> 日期：2026-08-21（本地时间）。

## 交付物

| 组件 | 路径 | 状态 |
| --- | --- | --- |
| HTTP Bridge | `services/roboframe-bridge/`（FastAPI，Bearer token，近无状态+内存终态登记） | ✅ 已实现 |
| 凭据类型 | `custom-nodes/n8n-nodes-roboframe/credentials/RoboFrameBridgeApi.credentials.ts`（含连接测试） | ✅ 已实现 |
| Robot Catalog | `nodes/RobotCatalog/`（catalog + config_digest + loadOptions） | ✅ 已实现 |
| Robot Status | `nodes/RobotStatus/`（授权/模式/busy/readiness） | ✅ 已实现 |
| Robot Skill | `nodes/RobotSkill/`（校验→执行→轮询至终态；可只提交不等待） | ✅ 已实现 |
| Robot Validate | `nodes/RobotValidate/`（dry-run 校验） | ✅ 已实现 |

## 自动化验证（本机可复跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Bridge 契约测试（Fake 客户端，17 例：鉴权/404/502/202 异步/终态头/容量上限/参数 flags） | `cd services/roboframe-bridge && python -m pytest -q` | 17 passed |
| 节点包单元测试（engine 顺序执行/首败即停/不重试/skipIf/超时；RobotSkill 校验拒绝；RobotTask 摘要与 digest 失效；SkillPlan 后端重编译防篡改） | `cd custom-nodes/n8n-nodes-roboframe && pnpm vitest run nodes` | 17 passed |
| 节点包 typecheck / lint / build | `pnpm typecheck && pnpm lint && pnpm build` | 全部通过 |
| v1 回归（blockly-data-transform 16 例 + BlocklyCode 18 例） | 各包 `pnpm vitest run` | 全部通过 |

## 设计符合性

- ✅ 单飞行租约：每步一个 gateway 租约，engine 顺序执行（设计 §5.3/§7.5 已决 #3）。
- ✅ 失败/超时不自动重试：engine 首败即停，无内建重试；重试决策留给 n8n 工作流错误分支（§6.3）。
- ✅ 取消后状态未知不得表述"已停止"：`state=unknown` 原样透传。
- ✅ 不提供 `authorize_motion` 入口：bridge API 面无此端点；未授权时执行链在机器人侧被 Gateway 拒绝，节点把错误上报为 NodeOperationError。
- ✅ 凭据只存 n8n 凭据库；日志不打印 token / payload / workspace（bridge 错误只透传 `detail`/`message`）。
- ✅ 错误分类（§6.3）：参数/校验/过期 → UserError 语义；bridge 不可达 → `bridge unreachable: ...`（走 n8n 错误分支）。

## 未覆盖（按设计留待后续）

- ⏭ 仿真端到端（`use_sim:=true` + Gazebo + `robot-skill`）：需 ROS 2 环境，验收场景按设计为"单技能链路"（Webhook/Schedule → Status → Skill → 输出），在具备 ROS 环境的机器上执行 `services/roboframe-bridge/README.md` 部署步骤后复验。
- ⏭ CLI JSON 映射联调：`RobotSkillCliClient` 的输出解析需对照真实 `robot-skill --json` 校准（README 已注明）。
- ⏭ Playwright 浏览器验收：属 Phase 2 交付范围（依赖 Robot Skill Plan 节点）。

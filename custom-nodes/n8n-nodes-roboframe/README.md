# n8n-nodes-roboframe

RoboFrame（IB-Robot）技能节点族：通过 [RoboFrame HTTP Bridge](../../../services/roboframe-bridge/README.md)
消费 `robot-skill` sanctioned 边界。架构与安全边界见
[设计稿](../../../docs/roboframe/roboframe-integration-design.md)。

## 节点

| 节点 | 用途 |
| --- | --- |
| **Robot Catalog** | 列出技能目录（含 `configDigest`）；`Include Details` 附带参数 schema 与策略 |
| **Robot Status** | 查询 Gateway：`motionAuthorized / controlMode / busy / readiness` |
| **Robot Skill** | 执行单个技能：先校验（可选）→ 提交 → 轮询至终态；可设为仅提交 |
| **Robot Validate** | 参数 + Gateway 安全校验（不产生运动） |
| **Robot Task** | 顺序执行结构化 `RobotTaskPlan`；每步一个租约；失败即停并给出摘要 |
| **Robot Skill Plan** | Blockly 可视化编排技能计划；编译输出计划 JSON 或直接执行 |

## 凭据

`RoboFrame Bridge API`（`baseUrl` + `token`）——token 为机器人侧
`ROBOFRAME_BRIDGE_TOKEN`。连接测试调用 `GET /v1/health`。

## 安全语义（继承 RoboFrame）

- 所有执行经 bridge → `/embodied/execute_skill` → `safety_guard`；无任何直连控制接口。
- 失败/超时**不自动重试**；`recovery_policy` 决定是否允许人工配置重试。
- 不提供（也不会）开启 `authorize_motion` 的入口。
- 执行期校验 catalog `configDigest`，不一致报"计划已过期"（`Robot Task` / `Robot Skill Plan`）。

## 开发

```bash
pnpm install
pnpm build      # n8n-node build → dist/
pnpm test       # vitest run nodes
pnpm typecheck && pnpm lint
```

直载运行：`N8N_CUSTOM_EXTENSIONS=<repo>/custom-nodes/n8n-nodes-roboframe/dist pnpm start`
（节点类型前缀为 `CUSTOM.`）。

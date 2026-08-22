# RoboFrame HTTP Bridge

把 RoboFrame 的 catalog、status、action validate/execute 和 task cancel
边界暴露为 REST API，供 n8n 的 RoboFrame 节点族调用。Bridge 只负责协议转换、
短期任务状态和 CLI 生命周期；运动准入与安全裁决仍由 RoboFrame Gateway 完成。

## 边界与运行约束

- 所有 action 都携带 `{kind, name}`。当前 RoboFrame HEAD 的 CLI 只公开 skill，
  因此真实目录固定返回 `primitives: []`，primitive 请求在目录检查处结束。
- Bridge 未暴露 `authorize_motion` 开关；运动授权由操作员在 launch 阶段设置。
- Bearer token 来自 `ROBOFRAME_BRIDGE_TOKEN`。空值表示本机联调模式。
- Bridge 本身不终结 TLS。局域网部署使用 token；跨网段部署在反向代理处终结 TLS。
- 内存保留全部活动任务和最近 256 条终态。长期记录由 n8n 执行历史保存。
- 失败与超时不自动重试；n8n 根据 capability 的 `recovery_policy` 决定后续动作。

## 部署

```bash
cd services/roboframe-bridge
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"

export ROBOFRAME_BRIDGE_TOKEN="$(openssl rand -hex 24)"
export ROBOT_CONFIG_NAME=so101_single_arm
export ROBOFRAME_BRIDGE_BIND=0.0.0.0
export ROBOFRAME_BRIDGE_PORT=8090

roboframe-bridge
```

也可使用 `ROBOT_CONFIG_PATH=/abs/path.yaml`。机器人侧进程启动前应加载 ROS
工作区，使 `robot-skill` 位于 `PATH`。

## API v1

| 方法/路径 | 说明 |
| --- | --- |
| `GET /v1/health` | 存活与 bridge 版本；公开 |
| `GET /v1/catalog` | 完整 skill 详情、位姿、digest；当前 `primitives[]` 为空 |
| `GET /v1/catalog/skills/{name}` | skill 详情 |
| `GET /v1/catalog/primitives/{name}` | primitive 详情 |
| `GET /v1/catalog/poses` | 命名位姿 |
| `GET /v1/status` | Gateway 授权、控制模式、busy、digest、control-plane 与 capability readiness |
| `POST /v1/actions/validate` | 校验一个带 kind 的 action；不执行 |
| `POST /v1/actions/execute` | 异步提交 action；返回 accepted 记录 |
| `GET /v1/tasks/{task_id}` | 查询 accepted、running 或终态 |
| `POST /v1/tasks/{task_id}/cancel` | 请求取消并返回确认语义 |

旧的 `/v1/skills/validate` 与 `/v1/skills/execute` 已退出协议。

### Catalog 契约

Bridge 先调用 `list-skills`，随后对每个 skill 调用 `describe NAME`，最后调用
`list-poses`。三个读取步骤的 `robot_name` 和 `config_digest` 必须一致；读取中发生
变化会整体失败，避免生成混合版本的教学图。`GET /v1/catalog` 的完整形状为：

```json
{
  "robot_name": "so101_single_arm",
  "config_digest": "sha256:CATALOG_DIGEST",
  "skills": [
    {
      "kind": "skill",
      "name": "move_relative_ee",
      "contract_schema_version": 2,
      "summary": "Move the end effector relative to its current pose.",
      "domain": "manipulation",
      "moves_robot": true,
      "required_control_mode": "moveit_planning",
      "parameters": {
        "type": "object",
        "properties": {
          "motion_direction": {"type": "string"},
          "motion_distance": {"type": "number"}
        },
        "required": ["motion_direction", "motion_distance"]
      },
      "recovery_policy": "never_retry",
      "timeout_policy": {
        "default_skill_timeout_sec": 120.0,
        "task_budget_sec": 180.0,
        "rpc_timeout_sec": 5.0
      },
      "timeout_sec": 120.0,
      "config_digest": "sha256:CATALOG_DIGEST"
    }
  ],
  "primitives": [],
  "poses": ["home", "observe_table", "zero"]
}
```

提交前，Bridge 会在与 `kind` 对应的数组中查找同名 action。名称只出现在另一种
kind 的数组中时也返回 404，例如 `{kind:"primitive", name:"inspect_scene"}`
不会进入 skill 分派。

### 校验请求

```http
POST /v1/actions/validate
Authorization: Bearer TOKEN
Content-Type: application/json

{
  "action": {"kind": "skill", "name": "move_relative_ee"},
  "params": {"motion_direction": "forward", "motion_distance": 0.03}
}
```

```json
{"valid": true, "error_code": "", "message": ""}
```

`kind` 只接受 `skill` 或 `primitive`。请求使用严格字段集，旧的顶层 `skill`
字段会得到 422。RoboFrame CLI 的成功结果 `{allowed, reason}` 映射成
`{valid, message}`；结构化错误的 `error.code` 映射成 `error_code`。

### 提交与查询

```http
POST /v1/actions/execute
Authorization: Bearer TOKEN
Content-Type: application/json

{
  "task_id": "workflow-42:block-7:attempt-1",
  "action": {"kind": "skill", "name": "move_relative_ee"},
  "params": {"motion_direction": "forward", "motion_distance": 0.03},
  "timeout_sec": 15,
  "context": {
    "workflowId": "workflow-42",
    "workflowNodeId": "node-robot-task",
    "blockId": "block-7"
  }
}
```

Bridge 在创建工作线程前原子登记 task ID：

```http
HTTP/1.1 202 Accepted
```

```json
{
  "accepted": true,
  "task_id": "workflow-42:block-7:attempt-1",
  "action": {"kind": "skill", "name": "move_relative_ee"},
  "state": "accepted"
}
```

随后 `GET /v1/tasks/workflow-42%3Ablock-7%3Aattempt-1` 始终可查询该活动记录：

```json
{
  "task_id": "workflow-42:block-7:attempt-1",
  "action": {"kind": "skill", "name": "move_relative_ee"},
  "state": "running",
  "terminal": false,
  "success": null,
  "error_code": "",
  "message": "",
  "executed_step_count": 0,
  "context": {
    "workflowId": "workflow-42",
    "workflowNodeId": "node-robot-task",
    "blockId": "block-7"
  },
  "accepted_at": "2026-08-22T01:00:00Z",
  "started_at": "2026-08-22T01:00:00.010000Z",
  "updated_at": "2026-08-22T01:00:00.010000Z",
  "finished_at": null,
  "cancel_requested": false
}
```

活动任务查询没有“登记等待期”。404 表示当前 bridge 未登记该 ID，或对应短期终态
已因重启/容量边界离开内存；它不表示刚提交的任务仍在后台等待登记。

状态机固定为：

```text
accepted -> running -> completed
                    -> failed
                    -> canceled
                    -> unknown
```

`completed / failed / canceled / unknown` 的响应包含 `terminal=true`，同时响应头
`X-Terminal-State: True`。`unknown` 表示结果尚无可靠证据，后续得到已确认终态时
可细化为 `completed / failed / canceled`。

同一个 `task_id` 再次提交返回确定性的 409，且不会启动第二次动作：

```json
{"detail":"task_id already exists: workflow-42:block-7:attempt-1 (state=running)"}
```

RoboFrame `execute` 最后一行是 `{event:"result", data:{success,error_code,
message,executed_step_count}}`。即使命令以非零状态退出，Bridge 仍读取该终态：
`success=true` 为 `completed`，`SKILL_CANCELLED` 为 `canceled`，
`SKILL_CANCEL_TIMEOUT` 为 `unknown`，其余 `success=false` 为 `failed`。缺少
result 事件或 CLI 进程超时也登记为 `unknown`，因此已接受任务不会因边界异常消失。

### 取消与确认

```http
POST /v1/tasks/workflow-42%3Ablock-7%3Aattempt-1/cancel
Authorization: Bearer TOKEN
```

RoboFrame CLI 的 cancel 成功响应只证明 task 已进入 terminal，并不携带执行结果：

```json
{
  "task_id": "workflow-42:block-7:attempt-1",
  "requested": true,
  "state": "unknown",
  "message": "task stopped; terminal outcome is pending execution result",
  "confirmed": false
}
```

字段语义：

- `confirmed=true`：本地 task registry 已有 `completed`、`failed` 或 `canceled`
  明确终态。
- `state=running, confirmed=false`：取消请求已发出，调用方继续轮询 task。
- `state=unknown, confirmed=false`：取消截止内缺少明确终态，调用方保留 task ID
  和 unknown 证据。
- CLI 返回 `{already_terminal,cancel,status}` 时，Bridge 使用 `cancel.accepted` 填写
  `requested`，使用 `status.request_state` 判断 active/terminal；terminal 本身不被
  推断成 canceled。并行执行线程随后取得 result 事件时，可把 unknown 细化为明确终态。
- 对已确认终态再次调用 cancel，Bridge 返回该终态和 `requested=false`，并跳过
  第二次 CLI 调用。

## CLI 映射

| action kind | validate | execute |
| --- | --- | --- |
| `skill` | `robot-skill validate NAME ...` | `robot-skill execute NAME --task-id ID ...` |

RoboFrame HEAD 没有 primitive 的 catalog/describe/validate/execute 命令，Bridge 不构造
虚拟命令。HTTP 契约保留 `kind` 判别，真实 CLI provider 返回空 `primitives[]`。

CLI 参数中的对象和数组使用 UTF-8、键排序、无多余空白的规范 JSON。例如：

```text
{"profile":{"mode":"safe","speed":0.2}}
-> --profile {"mode":"safe","speed":0.2}
```

参数名从 JSON 的 snake_case 转成 CLI kebab-case，例如 `motion_direction` 转成
`--motion-direction`。布尔值使用 `true/false`，空值使用 `null`。`task_id` 和
`timeout_sec` 是独立请求字段，不进入 action params；`--timeout-sec` 只生成一次。

## 测试

```bash
pip install -e ".[dev]"
pytest
```

测试一部分使用 Fake 客户端验证 HTTP 状态机；另一部分使用按 RoboFrame HEAD 校准的
`list-skills`、`describe`、`list-poses`、`status`、`validate`、execute JSONL result 和 cancel
fixture，覆盖非零退出终态、digest 一致性、参数编码与未确认取消。实机验收继续验证
目标 RK3588 上的 ROS graph、Gateway 授权、机械臂动作和急停链路。

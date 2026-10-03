# tools/fake-bridge —— 开发用的**假 bridge**

这条链原本一步都发不出去：真的 `roboframe-bridge` 要 `robot-skill` CLI，CLI 要 ROS，这台机器上没有。
这个目录把 **HTTP 那一侧**立起来，好让「下发 → 轮询 → 终态 → 据此选哪条臂」在**真 HTTP** 上跑通，
而不是只做形状对账。**它是开发替身，不是产品代码。**

## 怎么起

要求 node ≥ 22.18（TS 类型剥除缺省开；本仓库 `engines` 本来就要求 ≥ 22）。**没有第三方依赖、没有编译步骤**
——`start.mjs` 用的是 node 自带的 `node:http` 与 node 自带的类型剥除。

```bash
node tools/fake-bridge/start.mjs                 # 默认 127.0.0.1:8788
FAKE_BRIDGE_PORT=0 node tools/fake-bridge/start.mjs   # 让系统挑端口（挑中的端口打在日志里）
```

| 环境变量 | 命令行 | 缺省 | 意思 |
| --- | --- | --- | --- |
| `FAKE_BRIDGE_PORT` | `--port` | `8788` | 监听端口。`0` = 系统挑一个，会在 `listening http://127.0.0.1:<port>` 那一行报出来 |
| `FAKE_BRIDGE_STEP_MS` | `--step-ms` | `800` | 一步「走」多久才落终态。这之前轮询读到 `state: "executing"` |
| `FAKE_BRIDGE_FAIL_SKILLS` | `--fail-skills` | 空（全成功） | 逗号分隔。名单里的技能落 `failed` / `success:false` |
| `FAKE_BRIDGE_UNKNOWN_SKILLS` | `--unknown-skills` | 空 | 逗号分隔。名单里的技能**从目录里摘掉**：`execute` 回 404、`validate` 回 `valid:false` |

`FAKE_BRIDGE_UNKNOWN_SKILLS` 是用来演「计划里有、这台 bridge 的目录里没有」的：
计划是拿**真目录**编的（所以真会发出去），对面不认，于是拿回一个真的 404。

## 它按哪份契约说话，那份契约由谁钉着

- 上游契约：`docs/reference/bridge_models.py`——从旧仓库 `services/roboframe-bridge/roboframe_bridge/models.py`
  原样抄来（commit `561f75f9`，只抄 models 那一层，FastAPI app 不抄）。
- 我们的镜像：`packages/robot-bridge/src/models.ts`（zod，字段名与约束逐字对应）。
- **谁钉着两者一致**：`packages/robot-bridge/test/model-parity.test.ts`——它把载荷交给 pydantic 亲自跑，
  两边结论必须相同（包括「多给的键不报错」这一条）。
- 这个服务**直接 import 那份 zod 镜像**校验进来的 body、构造出去的响应。所以它不是「随便一个假服务」：
  形状不对它自己先拒（400，并说明错在哪个字段）。

技能目录**不是手写的**：`GET /v1/catalog` 的每条技能来自 `@codecanvas/capabilities` 的
`ROBOFRAME_SO101_CATALOG`（`capabilities[].capabilityRef`，上游 commit 见那份目录的 `provenance`）。
`POST /v1/skills/execute` 就是拿请求里的 `skill` 去这份目录里比，不在就 404——与真身同一条判据
（`app.py`：`if request.skill not in {skill.name for skill in catalog_data.skills}`）。

## 端点

| 方法 / 路径 | 回什么 |
| --- | --- |
| `GET /v1/health` | `{status, service, version}`（真身里唯一不挂守卫的端点，这里也一样） |
| `GET /v1/catalog` | 真目录转出来的技能表 |
| `POST /v1/skills/validate` | `{valid, error_code, message}`；不在目录 → `valid:false` |
| `POST /v1/skills/execute` | 技能不在目录 → **404**；否则 **202** `{accepted, task_id, skill}`，并**异步**推进任务 |
| `GET /v1/tasks/{id}` | `{task_id, skill, state, success, error_code, message, executed_primitives}`；未知 id → **404**；带 `X-Terminal-State` 头 |
| `POST /v1/tasks/{id}/cancel` | `{task_id, requested, state, message}`；未知 id → 404 |
| `OPTIONS *` | `204` + CORS 头（`Access-Control-Allow-Origin: *`） |

`task_id` 未知就回 404 这条口径是从 `app.py` 读来的：`registry.get(task_id)` 返回 `None` 之后再去问
CLI，还是 `None` 就 `404 unknown task`。cancel 那边 `app.py` 没写清（它直接转发给 CLI），这里就照
「任务的真相在注册表里」办：注册表没有 → 404。

## 它**不是**什么

- **不是 bridge 的实现**：没有 ROS、没有 `robot-skill` CLI、没有任何东西真的动。任务的状态是 `setTimeout`
  推的，`executed_primitives` 是从真目录的 `implementation` 里读出来的（不是编的），仅此而已。
- **不转发**：没有上游可转。它就是链子的另一头。
- **不鉴权**：`Authorization` 带什么、不带什么，都收。真身是 Bearer token（`ROBOFRAME_BRIDGE_TOKEN`），
  本地开发可以关掉——这个替身**没有**那套东西，也**不假装有**。
- **不是端点全集**：真身还有 `/v1/catalog/skills/{name}`、`/v1/catalog/poses`、`/v1/status`，这里没实现
  （执行链用不到）。别的路径一律 404。
- **`/v1/catalog` 里 CLI 那几栏是占位**：`domain` / `moves_robot` / `recovery_policy` / `timeout_policy`
  在真身那边由 CLI 从 `skill_templates` 建出来，这个替身没有 CLI，就填了固定的说法。
  `config_digest` 用的是目录的 `revisionRef`（它确实是那份上游配置的摘要），不是编的。
- **形状不对回 400，真身回 422**：FastAPI 对 pydantic 校验失败回 422，这里按任务书回 400
  （`{"detail": "..."}`，形状照 FastAPI 的 `HTTPException`）。

## 日志：怎么证明「真的发出去了」

每个请求一行到 stdout，字段固定：

```text
[fake-bridge] POST /v1/skills/execute skill=inspect_scene task=plan-ab12cd34-0 status=202
[fake-bridge] task plan-ab12cd34-0 accepted skill=inspect_scene step_ms=150
[fake-bridge] GET /v1/tasks/plan-ab12cd34-0 skill=- task=plan-ab12cd34-0 status=200
[fake-bridge] task plan-ab12cd34-0 -> completed success=true
```

`packages/robot-bridge/test/run-http.test.ts` 就是读这些行来做证据的（「轮询真的发生过」「另一条臂的
请求一条都没发」都不是看事件，是看这张日志）。启动那两行是 `listening http://127.0.0.1:<port>` 与
`config ...`。

## 为什么要一个 `start.mjs` + `ts-resolve-hooks.mjs`

这个服务必须拿**真的** zod schema 与**真的**目录，而那两个包是按 bundler / vitest 的口径写的：
内部用无扩展名的相对导入、`.json` 不带 import attribute——裸 node 直接 import 会撞。
钩子只做这两件事（补 `.ts` 后缀、把 `.json` 装成 `export default`），类型剥除用的是 node 自带的
（v22.18 起缺省开）。**没有第三方依赖，没有编译步骤**；不去改那两个包的文件——那是别的包的目录，
而这是开发替身的需要。理由写在 `ts-resolve-hooks.mjs` 的文件头。

## 自己试一下

```bash
FAKE_BRIDGE_PORT=8788 FAKE_BRIDGE_STEP_MS=800 FAKE_BRIDGE_FAIL_SKILLS=open_gripper_skill \
  node tools/fake-bridge/start.mjs

curl -s localhost:8788/v1/catalog | head -c 200
curl -s -X POST localhost:8788/v1/skills/execute -H 'content-type: application/json' \
  -d '{"task_id":"demo-1","skill":"wave_hello"}'
curl -s localhost:8788/v1/tasks/demo-1        # 立刻问一次：executing
sleep 1
curl -s localhost:8788/v1/tasks/demo-1        # 再问：completed / success
```

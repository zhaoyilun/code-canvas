# 比赛软件切片一：验收记录与后续环境门

> 文档状态：软件切片验收记录
> 分支：`codex/competition-blockly-robot-framework-n8n`
> n8n-blockly 基线：`cd13e77691943e501b4978dfaa2e28be9684b021` 加本分支工作区实现
> RoboFrame 对照基线：`HEAD a2592f`
> 日期：2026-08-22

## 1. 验收结论

第一软件切片的确定性生成和执行契约已形成：

- 受限设计草稿可以同时生成 Blockly workspace 和候选 n8n WorkflowJSON；
- 生成器只使用传入 catalog 中的 skills、primitives 和 named poses；
- Blockly workspace 生成后立即回编译并做规范化语义等价检查；
- `blockId`、`planStepId` 和 n8n 计划/执行节点映射稳定；
- payload v2 把生成时 catalog 与 workspace 一起保存；
- 编辑器导入后仍按 payload catalog 注册、编译和保存；
- 候选 n8n 图包含 Robot Ready、整计划 Validate、Form 审核、批准/驳回、执行和完成/检查分支；
- Robot Skill Plan 只编译，Robot Task 是多步骤计划的唯一执行入口；
- 节点到 Bridge 的 action 契约保留 `skill | primitive` kind、digest 和步骤上下文；
- Bridge 软件契约覆盖 accepted、running、终态、取消和重复 task ID。

本轮通过的是源代码、单元测试、软件契约、构建产物和 Node 模块直载证据。它不等同于真实 n8n 实例导入、在线 Bridge、RK3588、RoboFrame CLI 或机器人动作证据。

## 2. 证据等级

| 标签 | 含义 | 本轮是否具备 |
| --- | --- | --- |
| `UNIT` | 纯函数、组件或节点单元测试 | 是 |
| `CONTRACT` | TypeScript/Python、catalog/payload、HTTP/CLI fixture 契约测试 | 是 |
| `BUILD_LOAD` | 包构建、dist 生成、Node require 或 Python import/compile | 是 |
| `JSDOM` | Vue 组件在 jsdom 中加载和交互 | 是，定向范围 |
| `N8N_IMPORT` | 目标 n8n 实例真实导入、保存、重载 | 待验 |
| `LOCAL_HTTP` | 真实 Bridge 进程和 n8n 节点经 HTTP 连接 | 待验 |
| `DEVICE` | RK3588、目标 RoboFrame 和机器人实机 | 待验 |

后续证据文件必须携带其中一个标签，禁止把 `UNIT`、`CONTRACT` 或 `JSDOM` 结果标成 `DEVICE`。

## 3. 分包测试与构建证据

### 3.1 `@n8n/blockly-robot-skills`

工作目录：`packages/@n8n/blockly-robot-skills`

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 3 个测试文件，35 项通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm format:check` | 通过 |
| `pnpm build *> build.log` | 通过，dist 已刷新 |

覆盖重点：

- catalog 严格解析和参数 schema；
- `RobotPlanDraft → Blockly workspace → RobotTaskPlan`；
- 稳定 block ID、plan step ID 和 source map；
- 生成后回编译与规范化语义等价；
- 未知能力、参数、input、隐藏链、重复 ID、空计划和大小限制；
- payload v2 的 catalog/workspace 往返；
- live catalog 的导入后确定性回编译；
- 旧 payload 和额外 plan preview 被明确拒绝。

证据标签：`UNIT`、`CONTRACT`、`BUILD_LOAD`。

### 3.2 `@n8n/competition-designer`

工作目录：`packages/@n8n/competition-designer`

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 2 个测试文件，13 项通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm format:check` | 通过 |
| `pnpm build *> build.log` | 通过 |

覆盖重点：

- Workflow SDK 生成真实节点类型和稳定节点 ID；
- Robot Ready、Robot Skill Plan、Robot Validate、Form 审核、Merge、Robot Task 和结果分流；
- Robot Ready 精确约束 `motionAuthorized=true` 且 `busy=false`，审批精确约束 `Approval Decision=Approve`；
- 拒绝、not-ready 和 needs-inspection 路径；
- `review_required` meta；
- 目标 RoboFrame 凭据 ID/name 引用；
- 禁止直接 HTTP 调用机器人动作端点；
- 同一份语义草稿产出 n8n 图、Blockly 图和 trace map；
- 草稿、机器人计划和 workflow policy 的分阶段诊断。

证据标签：`UNIT`、`CONTRACT`、`BUILD_LOAD`。

### 3.3 `n8n-nodes-roboframe`

工作目录：`custom-nodes/n8n-nodes-roboframe`

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 11 个测试文件，47 项通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build *> build.log` | 通过，6 个含 workspace runtime 的 dist 文件完成内嵌 |
| 按 `package.json` 注册列表逐项 `require` | 7/7 dist 节点模块加载成功 |

覆盖重点：

- Competition Design 读取 live catalog 与 named poses 并输出双图 artifact；
- Bridge catalog 到内部 RobotCatalog 的严格映射；
- live skill 的显式超时和 `default_skill_timeout_sec` 被保留到 Blockly catalog；
- Robot Status 保留真实 status 的 robot/digest/registry/control-plane/capabilities 字段；
- payload catalog 回编译，不再使用运行时固定 snapshot；
- Validate plan 在保留原计划的同时附加结构化 verdict；
- Robot Task 强制要求 plan-validation handoff 和 digest verdict；
- Validate 生成稳定键序 JSON 的 SHA-256 `planDigest`，Robot Task 在执行前重算并精确比对；
- skill/primitive 分派、wait、skipIf、失败即停；
- accepted/running/terminal 轮询；
- 超时触发 cancel，并区分 canceled 与 unknown；
- `blockId` / `planStepId` 进入步骤结果和 Bridge context；
- 完整失败 summary、task ID 和 catalog digest 结果；
- CUSTOM 节点类型和目标凭据引用进入生成图。

证据标签：`UNIT`、`CONTRACT`、`BUILD_LOAD`。

### 3.4 `roboframe-bridge`

工作目录：`services/roboframe-bridge`

| 命令 | 结果 |
| --- | --- |
| `python -m pytest -q` | 44 项通过 |
| `python -m ruff check .` | 通过，`All checks passed` |
| `python -m ruff format --check .` | 通过，7 个文件格式正确 |
| `python -m compileall -q roboframe_bridge tests` | 通过，退出码 0 |
| 仓库根 `git diff --check -- services/roboframe-bridge` | 通过，退出码 0 |

应覆盖：

- Fake provider 的 skill/primitive HTTP catalog；真实 HEAD fixture 的 `list-skills`、逐 skill `describe`、`list-poses`、digest 一致性和空 `primitives[]`；
- 真实 HEAD fixture 的完整 `status` 字段，包括 digest、registry、control-plane 和 capabilities；
- action 请求的严格 `{kind,name}` 边界；
- accepted 在工作线程启动前登记；
- running、completed、failed、canceled、unknown；
- 任务查询、重复 task ID 409 和有界终态历史；
- 背景异常写入 unknown；
- cancel 请求和确认语义；
- CLI JSONL 解码、`allowed/reason`、非零退出的结构化 result、嵌套参数规范 JSON 编码和 nested cancel；
- Fake provider 中 skill 与 primitive 的 kind 保持；真实 CLI provider 中 primitive 的明确未支持结果。

HTTP 状态机通过 FastAPI TestClient 进程内验证，RoboFrame HEAD 形状通过 mock subprocess fixtures 验证；测试未启动本机监听端口，也未调用真实 `robot-skill`、ROS、RK3588 或机械臂。证据标签为 `UNIT` 和 `CONTRACT`。启动真实 HTTP 进程并连接真实 RoboFrame 后才升级为 `LOCAL_HTTP` 或 `DEVICE`。

### 3.5 BlocklyEditor 定向验证

范围：`packages/frontend/editor-ui/src/features/shared/editors/components/BlocklyEditor`

| 检查 | 结果 |
| --- | --- |
| 目录内 3 个定向 Vitest 文件 | 11 项通过 |
| Vue/TypeScript 定向 typecheck | 通过 |
| Prettier | 通过 |
| Oxlint 定向检查 | 通过 |

覆盖重点：

- live catalog 跟随 payload 导入、编译和保存；
- 自定义 skill 参数通过 `PARAMS_JSON` 保持；
- Blockly 自动生成或已有的 block ID 进入编译计划；
- 初始加载期间不产生错误的 model update；
- Data Transform 原定向测试保持通过。

这些测试运行在 jsdom/隔离依赖环境。完整 `n8n-editor-ui` 构建、真实 Chromium 拖拽、保存重载和视觉检查仍列为后续验收。

证据标签：`UNIT`、`JSDOM`、`CONTRACT`。

## 4. 已通过的软件场景

| 场景 | 当前证据 | 结论边界 |
| --- | --- | --- |
| 结构化草稿生成两张图 | competition-designer 单测 | 证明确定性生成，不代表模型提示词质量 |
| 未知 skill/primitive/pose | generator 单测 | 生成前得到结构化诊断 |
| catalog digest 漂移 | generator/节点单测 | 软件能识别并阻止，不代表设备 catalog 已稳定 |
| Blockly 生成后回编译 | robot-skills 单测 | 证明 workspace 与 plan 语义一致 |
| payload 保存和重新解析 | package/editor 单测 | 证明 JSON 往返，不代表 n8n 数据库重载 |
| n8n 审核图结构 | workflow policy 单测 | 证明 WorkflowJSON 结构，不代表目标实例已导入 |
| readiness false | workflow/node 单测 | 证明 not-ready 分支存在 |
| 审批拒绝 | workflow/node 单测 | 证明 rejected 分支存在 |
| 计划失败或 unknown | engine/node 单测 | 证明结果分支和 trace 保存 |
| accepted/running | node/Bridge fixture | 证明状态契约，不代表真实进程时序 |
| timeout/cancel | node/Bridge fixture | 证明取消逻辑，不代表机器人已停稳 |
| primitive kind 分派 | 软件契约测试 | 证明 kind 保持，不代表 `a2592f` 有公共 primitive CLI |
| dist 节点加载 | Node require 7/7 | 证明模块可加载，不代表 n8n UI 已注册 |

## 5. 真实 n8n 导入待验

### 5.1 环境要求

- 与当前仓库相符的 n8n 版本；
- 当前分支构建出的 `@n8n/competition-designer`、Blockly 包和 RoboFrame 节点包；
- 7 个 RoboFrame/Competition 节点在目标实例可见；
- 一个测试专用 RoboFrame credential；
- Bridge 测试地址和 token；
- 一个 live catalog digest 固定的测试窗口；
- 工作流保持未发布状态。

### 5.2 导入验收步骤

1. 用 Competition Design 的成功输出保存 `n8nWorkflow` JSON；
2. 将占位凭据替换为目标实例 credential ID/name；
3. 导入目标 n8n；
4. 确认 14 个节点均有真实类型，无 missing node；
5. 核对 Robot Status 到 Robot Ready 的 true/false 端口；
6. 打开 Robot Skill Plan，确认 Blockly workspace 可加载；
7. 核对下拉能力来自 payload catalog，不来自固定 snapshot；
8. 修改一个参数后保存、关闭、重开；
9. 再次编译，核对 digest、block ID 和 plan step ID；
10. 运行到 Robot Validate，保持动作执行端隔离；
11. 验证 Approve、Reject 和 Not Ready 三条路径；
12. 导出工作流并再次导入一个空白测试项目；
13. 比对节点、连接、payload、credential 引用和 meta；
14. 保存 n8n 版本、浏览器截图、导出 JSON 和执行 ID。

### 5.3 导入退出标准

- 14/14 节点加载；
- 所有连接端口方向正确；
- Robot Skill Plan 保存重载后 workspace 和 catalog digest 一致；
- Approve 之前没有 Robot Task 提交；
- Reject 和 Not Ready 路径没有 action 提交；
- 导出再导入后无 missing node；
- 证据标记为 `N8N_IMPORT`，仍不标记为 `DEVICE`。

## 6. 本机 Bridge 在线待验

在进入 RK3588 前，先完成本机真实 HTTP 进程门：

1. 启动真实 FastAPI/uvicorn Bridge；
2. 使用 fixture RoboFrame CLI 进程，而不是内存 Fake；
3. 从 n8n 节点经 HTTP 请求 health、catalog、poses 和 status；
4. 提交一个慢任务，观察 accepted 和 running；
5. 提交重复 task ID，核对 409；
6. 触发 timeout，核对 cancel 请求和最终状态；
7. 触发 CLI 非法 JSONL、非零退出和进程异常；
8. 核对 token 错误、网络中断和 fetch timeout；
9. 保存 Bridge 日志、n8n execution JSON 和请求时间线。

退出后证据标记为 `LOCAL_HTTP`。它仍只证明本机协议闭环。

## 7. RoboFrame `a2592f` primitive 决策门

当前内部 REST 和 TypeScript 契约支持 `skill | primitive`，但 RoboFrame `HEAD a2592f` 尚未提供已确认的 primitive 公共 CLI/公开 catalog 证据。

硬件阶段先执行只读探针：

```text
robot-skill --help
robot-skill --config-name ROBOT_CONFIG_NAME list-skills
robot-skill --config-name ROBOT_CONFIG_NAME describe SKILL_NAME
robot-skill --config-name ROBOT_CONFIG_NAME list-poses
robot-skill --config-name ROBOT_CONFIG_NAME status
robot-skill validate --help
robot-skill execute --help
robot-skill cancel --help
```

若目标版本另有官方命令或 API，则按官方接口补充探针。随后依据 live catalog 选择：

- 公共 primitive catalog + CLI：启用 primitive 路径；
- 其他稳定公共接口：只调整 Bridge adapter；
- 仅 skills：`primitives[]` 为空，课程草稿不生成 primitive；
- 需要 upstream 扩展：冻结新 RoboFrame commit 和 CLI/JSONL 契约后再验收。

在该门通过前，primitive 软件测试保持 `CONTRACT` 标签。

## 8. RK3588 硬件阶段输入清单

### 8.1 计算平台与系统

- RK3588 板卡品牌、准确型号、硬件 revision；
- RAM、eMMC/NVMe、可用空间；
- CPU/NPU/GPU 频率策略和目标负载；
- 电源规格、散热器、风扇和机箱；
- BSP、bootloader、内核和设备树版本；
- OpenHarmony 版本、API level、发行形态；
- RoboFrame/ROS2 是原生运行、容器运行还是外部 Ubuntu 主机运行；
- arm64 Python、Node.js、pnpm、Docker/Podman 版本；
- 进程守护、开机顺序、日志目录和磁盘轮转策略。

### 8.2 RoboFrame 软件基线

- 精确 Git commit、构建参数和安装包哈希；
- `robot-skill` 可执行文件路径和 SHA256；
- CLI `--help` 完整输出；
- catalog、status、validate、execute、cancel 的原始 JSONL 样本；
- skill 与 primitive 的公共接口结论；
- config 文件、`robot_name` 和 live `config_digest`；
- named poses 原始目录；
- ROS2 distribution、RMW、MoveIt 和 controller 版本；
- motion authorization 的操作员流程；
- recovery policy 和任务并发规则。

### 8.3 机器人本体与安全

- 机器人型号、序列号占位引用、控制器和固件；
- 关节数量、限位、速度、加速度和工作空间；
- 末端执行器、夹爪和负载；
- 标定文件、零位、home/observe 等命名位姿；
- 急停、驱动使能、断电和人工接管方式；
- 测试围栏、操作者位置和安全距离；
- 第一批允许动作、禁用动作和参数上限；
- 取消后的停稳判定与人工确认步骤。

### 8.4 传感器与总线

- 摄像头型号、接口、分辨率、帧率和驱动；
- 麦克风、扬声器、显示屏和触控；
- USB、UART、CAN、I2C、SPI、GPIO 的实际用途；
- 编码器、限位开关、力/扭矩或碰撞传感器；
- 设备节点、udev/权限、OpenHarmony 权限清单；
- 所有线缆、供电域、接地和隔离要求。

### 8.5 网络与部署拓扑

- n8n、Bridge、RoboFrame Gateway 分别运行在哪台设备；
- 固定 IP、子网、DNS、NTP 和时区；
- Bridge bind 地址、端口、Bearer token 交付方式；
- TLS 终结位置和证书；
- 比赛现场是否完全离线；
- 模型服务在云端、本地 CPU 还是 RK3588 NPU；
- 防火墙、代理、热点和断网恢复方案；
- 浏览器 kiosk、屏幕分辨率和输入设备。

### 8.6 AI 与教学输入

- 使用的模型、版本、上下文长度和结构化输出能力；
- 本地模型运行时及 RKNN/NPU 版本；
- 允许的云服务范围；
- 课程提示词集和 30 条验收任务；
- 每条任务允许使用的 live catalog 子集；
- 教师审核话术和失败解释；
- 学员匿名标识、教学事件保留周期和导出格式。

### 8.7 证据采集

- n8n execution、workflow export 和版本历史导出位置；
- Bridge/RoboFrame/ROS2 日志命令和时间戳格式；
- RK3588 CPU、内存、温度、功耗和 NPU 监控工具；
- 摄像机机位、屏幕录制和机器人全景录像；
- 每次运行的 `run_id`、workflow ID、task ID、block ID；
- artifact SHA256 和证据目录命名规则；
- 现场故障后保留原始日志的步骤。

## 9. RK3588 分级验收顺序

| 门 | 动作 | 退出标准 | 证据标签 |
| --- | --- | --- | --- |
| H0 输入冻结 | 收齐第 8 节信息 | 版本、硬件、安全和网络无空项 | `DEVICE_PREP` |
| H1 只读启动 | 启动服务，查询 health/catalog/status/poses | 进程稳定，时间同步，digest 固定 | `DEVICE_READONLY` |
| H2 校验 | 对允许动作执行 validate | 无运动，schema 和安全 verdict 可追踪 | `DEVICE_VALIDATE` |
| H3 单低风险 skill | 审核后执行一个低速动作 | 状态和视频一致，急停可用 | `DEVICE_ACTION` |
| H4 超时与取消 | 执行可控慢任务并取消 | RoboFrame 确认终态或记录 unknown，人工核对停稳 | `DEVICE_CANCEL` |
| H5 多步骤计划 | Blockly compile→Validate→Approve→Robot Task | 每步可映射到 block，失败即停 | `DEVICE_PLAN` |
| H6 n8n 双图闭环 | 自然语言/结构化生成、导入、修改、审核、运行、复盘 | 双图、执行和录像证据完整 | `DEVICE_E2E` |

H1 前不做机器人动作；H2 只做校验；H3 起每次动作都需要现场审核和急停人员就位。

## 10. 当前待验总表

| 项目 | 当前状态 | 下一份证据 |
| --- | --- | --- |
| 结构化草稿到双图 | 软件测试通过 | 提示词集和真实模型 |
| Blockly live-catalog 往返 | 软件测试通过 | 真实 Chromium 保存重载 |
| n8n 候选图策略 | 软件测试通过 | 目标实例导入/导出 |
| 自定义节点 dist | 7/7 模块直载 | n8n UI 节点注册 |
| Bridge 状态机 | Fake/fixture 测试 | 本机 HTTP 进程 |
| RoboFrame JSONL | HEAD 形状的 mock subprocess fixture 已通过 | 目标 build 原始输出 |
| primitive | 软件 kind 契约通过 | `a2592f` 后续版本/适配路线决策 |
| RK3588 部署 | 尚未开始 | H0/H1 |
| 机器人动作 | 尚未开始 | H3 起的分级证据 |
| 教学成效 | 尚未测量 | 课程试验和可复算事件 |

## 11. 交付边界

软件切片一可交付用于代码评审和下一门集成。对外演示时应使用以下准确表述：

> 已完成受限 AI 设计草稿到 n8n/Blockly 双图的确定性软件生成、live-catalog 固定、稳定映射、受审查执行图和 RoboFrame action 状态契约；当前证据为软件测试与构建结果。目标 n8n 导入、在线 Bridge、RK3588、RoboFrame primitive 公共接口和机器人实机动作按后续验收门逐项补证。

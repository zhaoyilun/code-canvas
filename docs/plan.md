# 实施规划（按目标图倒推）

本文把目标界面拆成可施工的模块，排出里程碑与依赖，并划清子代理的文件边界。
当前阶段的范围见 §3：**只做「任务 JSON → 三个视图」这条链**，执行、仿真、设备、AI 生成全部后置。

契约细节见 [`spec.md`](spec.md)，继承判定见 [`inherited.md`](inherited.md)。

## 1. 图面拆解

| 图面区域 | 模块 | 本阶段 |
| --- | --- | --- |
| 品牌条 + 固定分区（**无 tab**） | `studio/shell` | **做**（切换机制已拆除） |
| 任务 JSON 输入带 + 转译链指示 | `studio/shell` | **做**（本阶段唯一真实输入口） |
| 右栏上方：虚拟设备 | `studio/views/right` | **做**（常驻；如实说明设备层未接入） |
| 左栏 Blockly 画布 | `studio/views/blockly` + `packages/blockly-toolkit` | **做**（唯一可写） |
| 中栏 Workflow 画布 | `studio/views/flow` | **做** |
| 两栏之间的虚线 | 生成期映射表 + `studio/views/mapping` | **做** |
| 右栏 CODE 面板 | `studio/views/code-panel` | **做**（编译产物） |
| 右栏 EXECUTION TRACE + 步骤列表 | `studio/views/trace-panel` | 后置 |
| 右栏 3D 机器人 | `studio/views/simulation` | 后置 |
| 底部六段流水线 | `studio/shell` | 只做前三段（导入 / 校验 / 编译），其余灰置 |
| 右下 RUN / STOP | `studio/shell` | 后置（先占位，打日志） |
| 设计期差异审核 | `studio/views/design-diff` | 后置 |
| 执行回放 | `studio/views/runtime-replay` | 后置 |
| 设备选择 | `studio/views/device-panel` | 后置 |

## 2. 目录结构

```text
codecanvas/
  apps/studio/src/
    shell/                    # 五 tab、三栏、底部流水线、主题变量
    views/
      blockly/  flow/  code-panel/  mapping/
  packages/
    contracts/                # 任务协议 schema + workflow 声明 + 稳定 ID + 诊断
    task-import/              # 任务 JSON → workflow 声明
    blockly-toolkit/          # 积木定义（由校验器推导）、编译回声明、主题、映射表
    code-render/              # 声明 → 代码面板文本（规则由校验器推导）
  test/{fixtures,e2e}/
  docs/
```

三条布局纪律：

- **校验器是唯一规格来源。** 积木的字段、代码面板的渲染，全部从它推导，不许另写平行定义。
- **映射表的生成在 `blockly-toolkit`（生成期），`views/mapping` 只负责画线。** 视图算不出映射。
- **契约全部落在 `packages/contracts`**，稳定 ID 生成器也在这里——「id 谁生成、怎么生成」必须有唯一答案。

后置的包（`core` 执行器、`code-runner`、`device`、`simulation`、`ai-plan`、`server`）暂不建。

## 3. 里程碑

### 当前阶段

```mermaid
flowchart LR
  M0["M0 骨架"] --> M2["M2 三视图"]
  M1["M1 协议与转换"] --> M2
  M2 --> M3["M3 映射与联动"]
```

#### M0 — 骨架 ✅

已交付：五 tab、三栏、六段流水线（前三段可达）、RUN/STOP 占位、自有主题变量。
`pnpm --filter @codecanvas/studio dev` → http://localhost:5173。

**产出**：能跑起来的空壳。五个 tab 可切换（后三个是占位），三栏布局成形，自有主题变量
（不引用任何 n8n token），底部流水线的前三段可用、其余灰置，RUN/STOP 占位。

**验收**：
- `pnpm dev` 起来，浏览器见到三栏 + 五 tab + 流水线；切 tab 时右栏内容切换。
- 空壳里不出现任何 `@n8n/*` 依赖（lockfile 断言）。
- 流水线不显示任何未实现状态——灰置就是灰置，不假装。

**依赖**：无。

#### M1 — 协议与转换 ✅

已交付：`packages/contracts`（json / sha256 / diagnostic / stable-ids / task-protocol / workflow）与
`packages/task-import`（任务 JSON → 声明）。184 + 15 条测试全绿，其中 72 条语料与
`docs/reference/task_protocol.py` 逐条对照（含报错原文逐字比对）。

**产出**：`packages/contracts`（任务协议 schema + 声明 schema + 稳定 ID + 诊断）、
`packages/task-import`（任务 JSON → workflow 声明）。校验规则逐条照 `task_protocol.py` 搬，
包括七种动作的字段约束、传感器白名单、限值只能收紧不能放宽、总时长上限。

**验收**：
- 给一份任务 JSON，产出确定的声明；**除身份字段（`id` / `digest`）外，同一输入连续两次的规范化产物字节相同**。
- 非法任务逐条有诊断，且带定位：未知 action、重复 step id、超限的 linear、越界的 joint_id、
  `distance` 落在 (0, 2] 之外、限值被放宽、总时长超 `max_duration`。
- **限值放宽必须被拒**（`max_linear > 0.3` 这类）。
- 校验器与 `task_protocol.py` 的行为一致性有测试（同一批输入，两边结论相同）。

**依赖**：无。与 M0 并行。

#### M2 — 三视图

**产出**：`views/flow`（节点链 + 失败态占位）、`views/blockly`（zelos + 自有主题，
七种动作各一块）、`views/code-panel`（编译产物）、`packages/blockly-toolkit`（积木定义与编译回声明）、
`packages/code-render`。

**验收**：
- 同一份声明，三个视图同时正确渲染；**积木的形状由校验器推导**，不是手写的七块。
- **改积木上的参数 → 代码面板那个数字跟着变**（这条联动是核心）。
- 改出非法值（`distance = 0`、`joint_id = 9`）时给诊断并拒绝写回，不静默修正。
- 积木观感接近 Scratch，但仓库内不出现 Scratch 的名字、Logo、角色形象。
- 代码面板的渲染规则可追溯到校验器（有测试对照）。

**依赖**：M0、M1。

#### M3 — 映射与联动 ✅

已交付：三处同一序号徽标（积木那枚画在 SVG 里，跟着块走而不是浮层）、三向选中联动、
跨栏连线层 `views/mapping`（每个步骤两段带箭头的线，端点误差实测 0.000px，
栏宽重排 / 中栏滚动 / 积木缩放 / 拖动平移四种扰动下都不发散）。

**产出**：生成期映射表（`blockly-toolkit`）+ 渲染层（`views/mapping`）。

**验收**：
- **映射覆盖率 100%**：每个 step 都有对应的块与节点映射。
- 点积木 → 对应流程节点高亮；点节点 → 对应积木高亮。
- 无映射的块不画线。
- 映射条目指向的是**稳定 id**，不是数组下标——重排步骤后映射仍能对上。

**依赖**：M2。

### 后置（不在本阶段）

| 里程碑 | 内容 | 前置 |
| --- | --- | --- |
| 执行器 | 调度、节点接口、`CodeRunner` 沙箱 | 需要一个可执行的真相（现在只有声明） |
| 设备层 | `DeviceSession`、能力目录、OpenHarmony 插件 | 设备协议定稿 |
| 仿真与 trace | 状态仿真、步骤列表、逐块回放 | 执行器 |
| AI Plan | 自然语言 → 任务 JSON | 不归我们（第一步的生成器负责） |
| 审批 | 设计期 diff 审核 + 运行期确认 | 执行器 |

## 4. 子代理分工

**第一批（可立即并行）**

1. `shell` — 只写 `apps/studio/src/shell/**` 与全局样式。产出 M0。
2. `protocol` — 只写 `packages/contracts/**` 与 `packages/task-import/**`。产出 M1。

**第二批（M0、M1 落地后）**

3. `blockly-view` — 只写 `packages/blockly-toolkit/**` 与 `apps/studio/src/views/blockly/**`
4. `flow-view` — 只写 `apps/studio/src/views/flow/**`
5. `code-panel` — 只写 `packages/code-render/**` 与 `apps/studio/src/views/code-panel/**`

**第三批**

6. `mapping` — 只写 `apps/studio/src/views/mapping/**`（映射表生成在 3 里）

规矩：不许某个代理自己发明任务协议或声明格式；校验器只有 `packages/contracts` 一个来源。
3、4、5 三个都要用校验器推导自己的定义，谁都不许手抄一份。

## 5. 需要提前定的东西

**积木的可写程度。** 现在定的是「唯一可写」，那就意味着要处理非法中间态、要能编译回声明、
要有撤销重做。如果只想先看效果，可以先把积木做成只读，等联动做通了再开写——
但**别做成能拖却拖不动的形状**，那比不能拖更让人困惑。

**底部流水线当前显示什么。** 本阶段不执行，所以后三段不可达。建议只亮前三段
（导入 / 校验 / 编译），其余灰置。要么这样，要么整条先不画。

**代码面板的渲染风格。** 图里那份是 Python 味的伪代码，但一期协议的参数名是 `linear`/`angular`，
不是 `angle`；`stop_if_obstacle` 是原子动作，不是 if。**渲染规则从校验器推导，不要照图手写。**
具体长什么样（`move(linear=0.2, angular=0.0, duration=5.0)` 还是别的）需要一个样例定下来。

**`description` 字段的用途。** 任务里有它，但协议校验器不检查它。它是不是要显示在工作流画布上、
作为任务标题？定了才好排版。

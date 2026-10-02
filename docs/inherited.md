# 继承清单（从旧实现里挖出来的东西）

这份文档是施工依据。它把旧仓库 `/Volumes/MySSD/zhaoyilun/dev/code-canvas`
（n8n fork，含一套原创的「代码转双画布」实现）里值得继承的设计逐条挖出来，
对照本仓库的 `spec.md` / `plan.md` 标明判定。

**只继承设计与契约形状，不复制代码。** 旧仓库整体受 n8n 的 Sustainable Use License 覆盖，
本仓库是纯重写，Apache-2.0。

旧实现的完整状态在 commit `5ea2842c`（机器人部分在 `31b98914` 被删除前的最后一版）。
前作的文档自称：**「本文中的 draft schema 1.0 不再用于生成或导入」**，当前契约以
`software-slice-2-blockly-logic.md` 为准。引用 §14/§9 时都带这个时效警告。

判定分四类：**直接继承** / **需改造** / **已被推翻** / **全新（无先例）**。

---

## 0. 先说三处立场冲突（最需要你拍板的）

新 spec 和前作在三件事上**立场相反**。这不是谁对谁错，但必须选一个，不能含糊。

### 0.1 「一份声明两个视图」 vs 前作的「双真相、单映射」

新 spec §4 说：一份声明，两个视图，两张画布平权。

前作 §0.3 冻结决策第 5 条说的是：**「双真相、单映射：n8n WorkflowJSON 是宏观编排真相；
Blockly workspace JSON 是机器人详细计划真相；RobotTaskPlan 是派生执行产物；
GenerationManifest 只做映射与审计。」**

前作用两个真相源，是为了回避「谁是主」的争论。**你要平权，就得自己解决前作用
「digest + 每次重编译」解决的那个问题**（见 §2）。选平权没问题，但要认下这份债。

### 0.2 并列双栏 vs 前作的「节点下钻」

前作 §13.1 明确写：**「n8n 仍是主画布。Blockly 作为 Robot Skill Plan 节点的详细编辑视图出现，
不再创建第三套顶层流程页面。」** slice-2 又收得更紧：**「n8n 是唯一宏观工作流画布；
Blockly 只出现在需要展开内部逻辑的 n8n 节点中」**，且「宽面板采用左右双栏，左侧为真实
Blockly 拼图，右侧为确定性生成结果」——**那是面板内的左右双栏，不是画布间的跨栏连线。**

**结论：跨栏虚线（plan M3）是原创设计，前作刻意没做。** 但前作 §13.2 写了八条具体交互，
其中的高亮类条目可以直接当 M3 的验收标准（见 §5）。

### 0.3 新 spec 没有 digest 纪律，前作全靠它

新 spec §1 只有 `formatVersion: 1`，没有内容摘要、没有重编译规则、没有「预览不参与执行」。
而这是前作花最多篇幅论证的东西。**建议照单继承，见 §2。**

---

## 1. 数据模型与契约

### 1.1 直接继承

| 东西 | 旧位置 | 说明 |
| --- | --- | --- |
| 基元词法 | `dual-canvas-core/src/primitives.ts` | `stableReferenceSchema`（`/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/`，≤128）、`JsonValue`（拒绝 `__proto__`/`prototype`/`constructor`）、semver、时间戳、画布坐标。**spec §1 只说了 id 不可变，没说字符集——用这个补上。** |
| 稳定 ID 生成规则 | `src/stable-ids.ts` | `uuidV5` + 固定命名空间 + 前缀分层。同一输入重复生成得到字节级相同的 ID。 |
| 语句级/表达式级块引用 | `src/logic-block-refs.ts` | blockRef = `logic-<uuidV5(documentRef:nodeRef:statement:stepRef)>`；表达式子节点也有身份（`path` 是 `value` / `arguments:0` / `properties:key:value` 这类地址）。 |
| ID 规则（设计稿 §12.2） | design-v1 | `blockId = stableId(designId, planRef, stepRef)`、`planStepId = "step:" + blockId`。 |
| 诊断与结果 | `src/diagnostics.ts` | `ResultV1<T>`，不抛异常。`DiagnosticV1{code,severity,message,path,ref,details}`；`path` 两种约定：JSON 路径用点号、源码位置用 `source.<line>.<col>`。`details` 兼作结构化载荷载体。 |
| 源码位置与映射表 | `src/mapping.ts` | `SourcePointV1{line(1-based),column(0-based),offset(UTF-16)}`、`SourceSpanV1`、`SourceMapEntryV1{mappingRef,semanticRef,artifact{kind,ref},source?,context?}`。两条 entry 共享同一个 `semanticRef` 就表达了 `blockId ↔ nodeId`。 |
| 映射校验规则 | `src/contracts.ts` | ① ref 必须真实存在；② 若给了 `context.nodeRef`，ref 必须**恰好等于**由 `(documentRef,nodeRef,semanticRef)` 重算出的 ref（防伪造映射）；③ 同一 `mappingRef` 多处出现时内容必须逐字节一致。 |
| 跨表面 traceMap（slice-1 §4.3） | — | 映射链 **`intentStepId/stepRef ↔ blockId ↔ planStepId ↔ n8nPlanNodeId ↔ n8nExecutionNodeId`**，条目带 `surface: 'blocklyLogic' \| 'robotPlan'`。比 design-v1 的 sourceMap 多了 `surface` 与执行期节点 ID。 |
| 逻辑 IR | `src/logic-ir.ts` | `LogicExpressionV1`（19 kind）、`LogicStatementV1`（只有 set/delete/if/assert）、`LogicNodeDraftV1`。**`teaching{what,why,editable,expectedEffect}` 要保留**——它是教学侧栏的数据来源，spec 里没有。 |
| 确定性双画布生成 | `src/logic-generator.ts` | IR → Blockly 工作区 + blockRefs + sourceMap 的完整映射表（19 个 kind 逐条对应块类型与输入名）。**旧仓库最值钱的一块，1:1 可搬。** |
| 编译产物四元组 | `blockly-data-transform/src/index.ts` | `BlocklyDataPayload{schemaVersion:3, operationCatalog, workspace, javascript}`。**workspace 是唯一执行真相，`javascript` 只是预览、运行时永远重编译。** schemaVersion 严格相等。 |
| 编译规则与语义等价边界 | 同上 | 固定模板、嵌套写用写时复制、点分读用可选链且缺失给 `null`、集合操作给中性值、operation 编译成内联 IIFE。以及**拒绝清单**：直接/部分可选读、负数下标、可空转换、嵌套输出赋值、`assert(...)` 全部拒（`SOURCE_SEMANTICS_MISMATCH`）。 |
| 有界表达式语言 | `operation-runtime/src/operation-runtime.ts` | `OperationExpressionV1` 七种节点，深度 ≤16、节点 ≤128，**解释执行、不生成代码、不 eval**。 |
| 模块脚手架三件套 | `operation-sdk/src/operation-contracts.ts` | `ModuleScaffoldRequestV1`（只含 AST 证据：调用文本 + span + 字面量，**证据与判断分离**）、`OperationModuleTemplateV1`（宿主预生成的确定性外壳）、`OperationModuleAdmissionV1`（准入复验）。**第二值钱。** |
| 动态积木注册 | 前端 `BlocklyEditor/blockly.ts` | `OperationBlockDescriptorV1` → `createToolbox()` + `defineBlocksWithJsonArray()`，arity 在块定义时固定，不用 mutator。 |
| 编译期新鲜度守卫 | `blockly-data-transform` | 遇到动态块，按 `operationRef@version` 查 catalog，**若找到但 `implementationRef` 不一致 → 编译直接失败**，不静默改指。 |
| 文档顶层模型 | `src/contracts.ts` | `DualCanvasDocumentV1{workflow, canvases[], sources[], sourceMap[]}`。`SourceImporterV1` 是 spec 没定义的扩展点，保留。 |
| 教学视图配置 | `src/plugin-sdk.ts` | `WorkflowVisualProgrammingProfileV1` 序列化进 `workflow.meta.visualProgramming`，与 spec §1「meta 引擎不解释」一致。 |
| 能力计划映射三元组 | `blockly-capability-plan` | `{planRef, stepRef, blockId, stepIndex}`。 |
| AI 输出契约（slice-2 §5，**推荐照抄**） | `fixtures/design-draft-v2.json` | `{schemaVersion:"2.0", designId, revisionId, name, logicNodes[], robotPlan{}}`，`logicNodes[].{nodeRef,label,outputMode,statements[]}`，`statements[].{kind,intentStepId,targetField,value,teaching}`。**AI 只产出语义草稿，不产出任何一份图的 JSON**——图由确定性生成器输出。这与「NL→IR→两个视图」同构，且比 spec 更具体。 |
| 运行结果契约（设计稿 §9.5） | design-v1 | `RobotTaskExecutionResult{schemaVersion, requestedMode, finalStatus: completed\|failed\|cancelled\|unknown, catalogDigest, steps[]{blockId,planStepId,actionKind,actionName,status,startedAt,finishedAt,durationMs,runtimeTaskId,errorCode,message,executedPrimitives[]}}`。**这是 trace 粒度的答案。** |

### 1.2 需改造

| 东西 | 怎么改 |
| --- | --- |
| `createStableId` 的**语义** | 旧 ID 内容寻址（改标签/挪位置/重排语句都会改 ID）。spec §1 要求「生成即固定」。**把内容寻址降级为内容指纹**（判断同源用），引用 ID 改成生成时一次性分配。 |
| `WorkflowFragmentV1` 的 connections | 旧的是边表 + `entryNodeRefs/exitNodeRefs`；spec §1 是按源节点 id 索引的邻接表。spec 的更省，保留。 |
| `CapabilityCatalogV1` | 旧的有 `required`/`defaultValue`/`constraints`/`outputs`/`category`，spec §5 贫得多。**以旧 schema 为准再降采样**。另外旧仓库因为 skill/primitive 混用吃过亏（曾「把 primitive 名称送进 skill 接口」后被删），**capability 要保留 kind 判别字段**。 |
| `ExecutionPlanV1` + guard | 「有序步骤 + 依赖 + guard(run/skip)」不是节点图。可作第二类节点载荷，**不要**拿它替换 workflow。 |
| `DualCanvasPluginV1` | spec §5 只有 `DeviceSession`（活的连接），旧的有 `normalizeCatalog(raw)`（死的目录 + 校验）。**保留 normalizeCatalog 作为设备能力报告的净化步骤**。 |
| 设备调用契约（设计稿 §16.1） | 前作是 `RoboFrameActionRequest{taskId, action{kind,name,params}, catalogDigest, timeoutSec, context{designId,revisionId,planRef,blockId,planStepId}}`；spec 的 `invoke(capabilityId, args)` **三样都没有**（kind 判别、digest、trace context）。**照前作补齐**，否则 skill/primitive 混用问题会重演。 |
| `blockType` / `version` | 旧的 blockType 是不可读 uuidV5，version 是字符串常量（摆设）。改成可读稳定 slug，version 改整数，用内容哈希自动判定 +1。 |
| 能力积木选型 | 旧仓库两条路都实现了：纯函数「每模块一块」（arity 定死），设备能力「一块通用步骤块 + capability 下拉 + JSON 参数框」。**倾向后者**。 |
| Catalog 查找 | 旧的按 `qualifiedName/arity` 查找不带版本，同名多版本静默取字典序最小。改成禁止同名多版本或显式版本选择。 |
| `requestedMode: mock\|sim\|device` | **前作只在字段定义里出现过一次，没有语义定义、没说明 sim 与 mock 差别、没有 switch 逻辑。语义要自己写。** |
| 模块划分（设计稿 §22 + slice-1 §7） | 保留职责切分，换掉 `packages/@n8n/*` 路径。**重要修正：前作把 `mapping` 放在生成期包里（`competition-designer/src/mapping`），不是视图层。** 新 plan 把它划成 `apps/studio/src/views/mapping/**`（纯视图）是错的——映射表是生成期产物，视图只渲染它。 |

### 1.3 已被推翻

- 设计稿 §0.3 决策 1/2/4/5：n8n 为核心、双真相、Workflow SDK 路线、设计助手不是运行时节点。
- 设计稿 §13.1 页面布局与 §13.2 第 1 条（Blockly 作为独立下钻画布）。
- §10.3 Code 节点「默认禁用」→ slice-2 改成「生成器不产出 Code 节点」。
- §11.2/§11.3 全部（MCP 探针门与工作流结构规则）——随 n8n 一起消失。
- `NodeTypeBindingsV1` / `resolveNodeTypeBinding`：为「插件包名 + n8n 已安装节点类型名」这层间接而存在，spec §1 的 `type` 就是实现键，删掉。

### 1.4 全新（无先例）

- **节点接口**：spec §2 的「收批 + `Item[]` + `pairedItem` + `NodeContext` + `AbortSignal`」。旧的是 `runOnceForEachItem` 逐项语义。
- **跨栏连线**：前作刻意不做（见 §0.2）。
- **自然语言 → 整图 workflow**（M4）：旧仓库唯一的 LLM 调用是「未知纯函数 → 声明式模块草案」，`generatePlan` 是**零实现的空插槽**。可搬协议骨架（确定性外壳 → 模型只填语义字段 → 宿主推导身份 → 准入复验）+ slice-2 §5 的输出契约；要新写的是「整图生成」这一层。
- **`blockId ↔ 生成代码行范围`**：编译器只按 `type` + fields 走，**不读 `block.id`**，不是补个字段而是要加一条 blockId 上下文。
- **仿真**：零实现。
- **六段流水线的实现**：设计稿有**两台**状态机（见 §3），但不是六段。

---

## 2. 一致性纪律（前作花最多篇幅论证的东西，新 spec 完全没有）

五条，建议照单继承：

1. **保存的预览不参与执行**：§8.2 规则 1「保存的 JavaScript 预览、计划预览、解释文本都不参与执行」。
2. **每次运行从工作区重编译**：§9.3「`preview` 用于界面展示；运行节点忽略其中的 plan，再从 workspace 编译」。
3. **执行前重算摘要并精确比对**：acceptance §3.3「Validate 生成稳定键序 JSON 的 SHA-256 `planDigest`，Robot Task 在执行前重算并精确比对」。
4. **能力目录摘要三方对齐**：payload 存生成时的 `digest + capturedAt`；导入重开按 payload catalog 注册积木；执行前再读 live catalog，不同则停在执行前并给重新生成/审查入口（错误码 `CATALOG_DIGEST_STALE`）。
5. **映射覆盖率不足则锁定执行**：§8.2 规则 10「映射覆盖率低于 100% 时，执行按钮保持锁定」。

配套两条 ID 纪律：删除节点或积木时映射记录同步删除；每个可执行步骤必须携带稳定 `blockId` 与 `planStepId`。

**新 spec 需要补**：给 workflow 声明加内容摘要；`parameters` 里任何「生成产物预览」标注为只读派生；能力目录带 digest，`capabilities()` 变化即判定陈旧。

---

## 3. 生命周期与状态机

设计稿 §14 有**两台**状态机（不是一条六段流水线，全文没有 `Received`/`Succeeded` 这些词）：

**设计期**：`empty → generating → generated → structure_validated → domain_validated → review_required → approved → mock_verified → software_accepted`

**运行期**：`draft → preflight → pending_approval → approved → validated → accepted → running → completed | failed | cancelled | unknown`

规则：

1. 任何对图、积木、catalog digest 或执行策略的**有效修改**，状态退回 `review_required`；**只改视图位置或折叠状态不触发**复审。
2. **`unknown` 是正式终态**（取消或查询未获执行端确认），界面保留 taskId、最后状态与建议的检查动作。
3. 审核门**两道**：设计期（AI 改动以**差异**呈现，用户确认后才写草稿）、运行期（device 模式的运动任务在 Validate 之后才走批准）。mock 模式也保留设计期审核，用于教学「先看懂，再运行」。

**迁移守卫**（§15.1 六层校验，前作最接近"迁移表"的东西）：V1 候选规格 → V2 代码 → V3 图 → V4 Blockly → V5 领域 → V6 运行预检，每层失败回到对应状态。V6 的「停在 preflight」在 M-06/M-07 有实例。

**前作的空白（必须新造）**：**没有非法迁移表、没有迁移 API、没有"非法迁移"错误码**。它的防御是前置锁定（映射覆盖率不足则锁定执行），不是迁移守卫。

**⚠ 对新项目最大的风险**：新六段里只有 `Succeeded` 一个出口，而前作把 `failed | cancelled | unknown` 当**一等公民**。
**必须先回答：Succeeded 是唯一出口，还是失败/取消/未确认也占据第六格？** 前作的经验是后者——别把流水线做成只有成功路径的进度条。

**别混淆两套枚举**：步骤级 `TraceEntryV1.state`（`queued|running|succeeded|failed|cancelled|skipped`）是**步骤**执行态；六段流水线是**整次运行**的生命周期。

---

## 4. trace 粒度（回答 plan 的待定项）

前作的答案：**要做，粒度是「每一步 = 一个可执行块」**，不是 item 级也不是数据流级（前作没有 `pairedItem` 这类概念）。

形状见 §1.1 的 `RobotTaskExecutionResult.steps[]`，每项带 `blockId`/`planStepId`/`status`/时间戳/`runtimeTaskId`。
另有步骤级 `TraceEntryV1{state, location:{nodeRef?,canvasRef?,blockRef?,stepRef?}, input, output, error}` 与
`ExecutionEventV1.kind` 九态（`accepted/validationStarted/validationFailed/executionStarted/traceAppended/cancelRequested/succeeded/failed/cancelled`）。

用于「逐块回放」（§17.3 第 11 步、§20 阶段五）。**代码行级高亮前作没有**，要新做（且要先让编译器接住 blockId）。

---

## 5. 跨画布交互（前作有设计，只是选了不同形态）

前作否决了并列，但 §13.2 写了八条交互，其中五条对新项目仍然有效，**可直接当 M3 的验收标准**：

1. 点击 Blockly 块 → 对应的 n8n 父节点高亮，教学面板显示四层解释。
2. 点击 AI 对话中的某条决策 → 同时高亮 macro node 与相关 blocks（三点高亮）。
3. AI 修订以 proposal 显示，节点和积木分别标注新增、删除、修改。
4. 运行后按 `steps[]` 顺序回放。
5. 保存前显示双画布一致性摘要。

另有一条设计纪律（§13.3 + §23 风险 12）：**推断性说明标为「AI 解释」，执行结果标为「运行证据」，两者分栏显示。**
新 plan 的 `trace-panel` 没写这条。

---

## 6. 设备层（RoboFrame 考古）

旧实现的真相：**不是局域网发现 + 能力协商，而是手填 IP + token 的 REST 反代，包裹一个 CLI 工具。**

值得继承：

- **能力目录驱动积木**：设备上报 schema → 积木形状 → 编译期校验 → 执行期 digest 兜底。
- **连接期身份校验 + 时效校验**：编译产物带 `config_digest`，执行前与 live catalog 比对，不一致 = 「计划过期」，**不静默执行**。
- **三层参数校验**（编译期 → bridge → 设备端），外加一个自研 JSON Schema 子集校验器（`type/properties/required/additionalProperties:false/enum/const`，够用且无依赖）。
- **执行纪律四条**：单飞行、首败即停、不自动重试、**取消未确认不得称「已停止」**（记 `state=unknown`）。
- **异步提交 + 轮询 + 终态头**：`POST execute` 返回 202，`GET /v1/tasks/{id}` 轮询，终态判定走响应头 `X-Terminal-State: True`。终态注册表只记最近 256 条、重启即丢。
- **调用携带 trace context**：见 §1.2 的设备调用契约。

明确**没有**的：局域网发现（mDNS/扫描/配对）、WebSocket/SSE 推送、3D/运动学仿真、设备侧主动上报。所有状态获取都是工作台拉取。

**OpenHarmony 在这个仓库里是零代码。** 设计稿描述的是一个**外部独立工程** `harmony-blockly`
（已有 Blockly 编辑、隐藏 Runner WebView、HTTP/WebSocket、Dayu200 GPIO 链路，**没有** n8n/RoboFrame 集成）。
**OpenHarmony 版本与发行形态在前作里从头到尾没被确定**，它被列在「H0 输入冻结」门下的待确认输入里。

---

## 7. 验收与证据分级（新 plan 目前最缺的东西）

**七级证据标签**（acceptance §2）：`UNIT / CONTRACT / BUILD_LOAD / JSDOM / N8N_IMPORT / LOCAL_HTTP / DEVICE`。
硬规则：**「后续证据文件必须携带其中一个标签，禁止把 UNIT、CONTRACT 或 JSDOM 结果标成 DEVICE。」**

**真机侧另有 H0–H6 分级门**：`DEVICE_PREP / DEVICE_READONLY / DEVICE_VALIDATE / DEVICE_ACTION / DEVICE_CANCEL / DEVICE_PLAN / DEVICE_E2E`，
且「H1 前不做机器人动作；H2 只做校验；H3 起每次动作都需要现场审核和急停人员就位」。

**Mock 场景矩阵**（§17.2，**实际是 15 项**不是 14）：M-01 全成功 / M-02 第二步失败 / M-03 慢任务 / M-04 步骤超时 /
M-05 digest stale / M-06 未授权 / M-07 busy / M-08 教师驳回 / M-09 primitive / M-10 未知技能 / M-11 网络中断 /
M-12 重复 taskId / **M-13 保存重载** / **M-14 导出导入** / **M-15 AI 修订**。
**M-13/M-14/M-15 可原样移植**，其余依赖设备语义需改造。

**§17.1 的七问可直接当 M6 验收清单**（去掉机器人相关的两条）：AI 能生成两张可加载的图？慢任务在 accepted/running 期间可查询？
超时触发 cancel？失败结果仍有完整 steps？save/reload/export/import 后映射稳定？浏览器能逐块高亮？digest 变化得到清晰处理？

**前作每个阶段门都带可复跑的命令或百分比**（如「30 条提示词全部生成结构有效的两图」「映射覆盖率 100%」「相同输入得到相同规范化产物」「证据包 SHA256 校验」），
而新 plan 的验收全是 UI 可观察项。**要把这几条搬过来。**

---

## 8. 前端模块划分

设计稿 §22 给的前端模块可直接借用：`ai-design-panel` / `dual-canvas` / `design-diff` / `teaching-inspector` / `runtime-replay`。

**新 plan 缺的四个包/目录**（前作有）：

- `contracts` —— 前作把契约单独成目录并配 Zod 严格校验；新 spec 把格式写在 md 里，**没有对应的代码位置**。
- `stable-ids` —— 前作单独成文件；spec §1 只说「id 不可变」却没说谁生成。**被低估的模块。**
- `validation` —— 新 plan 的 `lifecycle` 只管状态高亮，没有校验器的落点。
- `catalog` —— 新 plan 并进 `core/device`；前作是独立 provider，因为**目录同时是设计期（决定积木）与运行期（决定校验）的输入**。

另有 `test/` 夹具目录（前作把 prompts/catalogs/workflows/e2e 独立且版本化）。

样式先例：`WorkflowCanvas.workbench.scss`（190 行 CSS 变量覆盖 + container query 三档降级 + `data-canvas-profile` 主题钩子）。
Blockly 主题：`teachingTheme.ts`（147 行，调色板/字体/光晕/toolbox 色全 token 化）——但 `blockly.inject` **没传 renderer**（跑默认 geras），`zelos` 全仓零命中，`startHats: false` 还关掉了 Scratch 最有辨识度的帽子。

---

## 9. 旧仓库踩过的坑

1. **prompt 与 schema 会静默漂移**。旧 prompt 说「恰好 4 条 testVectors」，schema 允许 3..32。模型可以交三条平凡向量 + 一个错表达式，通过所有闸门——那是**自洽而非正确**。新项目必须给至少一条**宿主自带**的期望值。
2. **`version` 字段是摆设**（恒为 `'1.0.0'`），真正在版本化的是内容哈希。建议把「内容变了就自动 +1」做成机械规则。
3. **catalog 查找不带版本**，同名多版本静默取字典序最小。
4. **operation 身份从不进生成的 JS**，要做 trace 必须**从第一天就让编译器接住 blockId**。
5. **三阶段 spec 共用一个 body schema**（只差 `implementationRef: null | string`），所以模型产出的 draft 与最终产物结构完全相同。保留。
6. **喂给模型的 schema 必须先做有界预检**（深度 >64 / 节点 ≥10000 / 有环 → 直接判失败），否则递归 Zod 解析会被打爆栈。前作吃过这个教训。
7. **不要把 operation 和 device 混成一条路**。纯函数走「每模块一块 + schema 强制 `effects:'none'`」，设备走「通用步骤块 + 下拉 + guard + timeout」。前作用 `routeIfIneligible: 'capability-plugin'` 这个字面量划的界。
8. spec §1 注释说「旧实现按节点名索引」——**更准确地说**，旧核心用 `nodeRef` 稳定 id，按名字索引只发生在前端适配层转 n8n `IConnections` 时（重名自动加 ` 2` 后缀）。
9. **一处标签不自洽**：前作的 `screenshots/04-real-execution-success.png` 文件名含 "real-execution"，但描述的实际是数据链路跑通，设备动作侧未提。**新项目要把「执行」再拆细（数据链路 / 设备链路）。**
10. 前作 §25 证据索引里有一半是**死链**（Windows 绝对路径、另一台机器）。新项目的证据索引必须指向可验证的仓库内路径。

---

## 10. 因此 spec / plan 要改的地方

**spec.md**

- §1：补 id 字符集（用 `stableReferenceSchema`）；写明「内容指纹 ≠ 引用 ID」；补内容摘要与「预览不参与执行」两条纪律。
- §2：不变（收批 + Item + pairedItem 是全新设计，方向对）。
- §3：说明 operation 表达式**不走** `CodeRunner` 沙箱；补 `unknown` 为正式终态。
- §4：第三行从「缓」改成**明确要求编译器接住 blockId**；映射表移到生成期产物而非视图层。
- §5：`CapabilityCatalog` 用旧 schema 的字段，补 `kind` 判别、digest、`normalizeCatalog` 的位置；`invoke` 补 `kind` 判别 + digest + trace context。
- 新增一节：一致性纪律（§2 那五条）。

**plan.md**

- 流水线：改用设计稿运行期状态机，并**回答「失败/取消/未确认是否占第六格」**。
- 前端模块：补 `design-diff` 与 `runtime-replay`；`mapping` 从视图层挪到生成期。
- 新增四个包：`contracts`、`stable-ids`、`validation`、`catalog`（或并入现有）。
- M3 验收：抄 §5 那五条高亮交互。
- M4：输出契约抄 slice-2 §5 的 schema 2.0 形态（AI 只产语义草稿，不产图的 JSON）。
- M6 验收：抄 §17.1 七问 + M-13/14/15 + 证据七级标签。
- 各里程碑：把「可复跑命令或百分比」补进验收标准。

/**
 * bridge 的请求与响应形状：**`docs/reference/bridge_models.py` 的 zod 镜像**。
 *
 * 为什么要有这一份：我们编出来的请求必须有形状判据——但判据不能是「我们照文档再写一遍的规则」，
 * 否则文档改了、我们的实现改了，两边一起错还互相点头。这里的每一栏都逐字对应
 * `bridge_models.py` 里的一个 pydantic 类（那份文件是从上游仓库原样抄来的，见它的文件头），
 * 而 `test/model-parity.test.ts` 会拿 **pydantic 亲自**验同一批载荷，两边结论必须相同。
 *
 * 三条纪律：
 * - **字段名逐字一致**（`task_id` / `timeout_sec` / `executed_primitives`… 照 python 那边写，
 *   不改成 camelCase）——名字就是接缝，改一个字母就是另一份协议。
 * - **约束一致**（`task_id` 1..128、`timeout_sec > 0`）。约束弱了会放行 bridge 会拒的请求，
 *   强了会拒掉 bridge 会收的请求，两种都是分叉。
 * - **不用 `.strict()`**：pydantic 缺省是 `extra='ignore'`（多给的键不报错），
 *   zod 的普通 object 也是「剥掉不认的键」，两边同一种行为。`.strict()` 会拒掉 bridge 收得下的载荷
 *   —— 镜像不许比被镜像的东西更严。
 *
 * 这里刻意**不做**的两件事：① 不写 HTTP 客户端（这一版只编译与对账，不发请求）；
 * ② 不把 `state` 收紧成枚举（`models.py` 写的是 `str`，取值全集在那行的注释里，
 * 收紧成枚举就成了我们的判据而不是 bridge 的）。
 */
import { z } from 'zod';
import { jsonValueSchema } from '@codecanvas/contracts';

/**
 * 对应 `CatalogSkill`。`parameters` / `timeout_policy` 在 python 那边是 `dict[str, Any]`，
 * 这里收成 JSON 对象（`Any` 能装的东西 JSON 装不下时本来也送不过 HTTP）。
 */
export const catalogSkillSchema = z.object({
	name: z.string(),
	summary: z.string().default(''),
	domain: z.string().default(''),
	moves_robot: z.boolean().default(true),
	required_control_mode: z.string().default(''),
	parameters: z.record(z.string(), jsonValueSchema).default(() => ({})),
	recovery_policy: z.string().default(''),
	timeout_policy: z.record(z.string(), jsonValueSchema).default(() => ({})),
});
export type CatalogSkill = z.infer<typeof catalogSkillSchema>;

/** 对应 `Catalog`（`GET /v1/catalog`）。技能表来自 CLI 的 `skill_templates`——**只有技能，没有原语**。 */
export const catalogSchema = z.object({
	robot_name: z.string(),
	config_digest: z.string(),
	skills: z.array(catalogSkillSchema),
});
export type Catalog = z.infer<typeof catalogSchema>;

/** 对应 `PoseCatalog`（`GET /v1/catalog/poses`）。 */
export const poseCatalogSchema = z.object({
	robot_name: z.string(),
	config_digest: z.string(),
	poses: z.array(z.string()),
});
export type PoseCatalog = z.infer<typeof poseCatalogSchema>;

/** 对应 `GatewayStatus`（`GET /v1/status`）。 */
export const gatewayStatusSchema = z.object({
	motion_authorized: z.boolean(),
	active_control_mode: z.string().default(''),
	required_control_mode: z.string().default(''),
	busy: z.boolean().default(false),
	active_task_id: z.string().default(''),
	readiness: z.record(z.string(), jsonValueSchema).default(() => ({})),
	ledger: z.record(z.string(), jsonValueSchema).default(() => ({})),
});
export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;

/** 对应 `ValidateRequest`（`POST /v1/skills/validate` 的请求体）。 */
export const validateRequestSchema = z.object({
	skill: z.string(),
	params: z.record(z.string(), jsonValueSchema).default(() => ({})),
});
export type ValidateRequest = z.infer<typeof validateRequestSchema>;

/** 对应 `ValidateResult`。**注意它只回答「这个技能收不收」**，不回答「跑起来成不成」。 */
export const validateResultSchema = z.object({
	valid: z.boolean(),
	error_code: z.string().default(''),
	message: z.string().default(''),
});
export type ValidateResult = z.infer<typeof validateResultSchema>;

/**
 * 对应 `ExecuteRequest`（`POST /v1/skills/execute` 的请求体）——**编译器的产物就是这个**。
 *
 * 三条约束都照 python 那边：`task_id` 1..128、`timeout_sec` 可省（省了就是 None）、
 * 给了就必须是正数（`gt=0`：0 秒的超时不是一个超时）。
 */
export const executeRequestSchema = z.object({
	task_id: z.string().min(1).max(128),
	skill: z.string(),
	params: z.record(z.string(), jsonValueSchema).default(() => ({})),
	timeout_sec: z.number().gt(0).nullish(),
});
export type ExecuteRequest = z.infer<typeof executeRequestSchema>;

/** 对应 `ExecuteAccepted`（202 的响应体）。`accepted` 缺省就是 true。 */
export const executeAcceptedSchema = z.object({
	accepted: z.boolean().default(true),
	task_id: z.string(),
	skill: z.string(),
});
export type ExecuteAccepted = z.infer<typeof executeAcceptedSchema>;

/**
 * `models.py` 里 `TaskResult.state` 那行注释点名的取值全集。
 *
 * 它是**词汇表**，不是 schema 的约束（schema 照 python 那边收 `str`，见文件头）——
 * 界面要用它做判断（「这个任务到终态了吗」），所以得有个地方写着全。
 */
export const TASK_STATES = ['planned', 'executing', 'completed', 'failed', 'canceled', 'unknown'] as const;

/**
 * 哪些 state 是终态。出处是 bridge 的 `app.py`（`TERMINAL_STATES`）——
 * `GET /v1/tasks/{id}` 还会在 `X-Terminal-State` 头里报同一个判断，两边口径一致。
 */
export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'canceled', 'unknown']);

/** 对应 `TaskResult`（`GET /v1/tasks/{task_id}` 的响应体）。`success` 可以是 null——「还没结论」。 */
export const taskResultSchema = z.object({
	task_id: z.string(),
	skill: z.string(),
	state: z.string(),
	success: z.boolean().nullish(),
	error_code: z.string().default(''),
	message: z.string().default(''),
	executed_primitives: z.array(z.string()).default(() => []),
});
export type TaskResult = z.infer<typeof taskResultSchema>;

/** 对应 `CancelResult`（`POST /v1/tasks/{task_id}/cancel`）。 */
export const cancelResultSchema = z.object({
	task_id: z.string(),
	requested: z.boolean(),
	state: z.string(),
	message: z.string().default(''),
});
export type CancelResult = z.infer<typeof cancelResultSchema>;

/** 对应 `Health`（`GET /v1/health`）。它**不要 token**（`app.py` 里唯一没挂守卫的端点）。 */
export const healthSchema = z.object({
	status: z.string().default('ok'),
	service: z.string().default('roboframe-bridge'),
	version: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

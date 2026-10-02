/**
 * RoboFrame 的技能计划：**这台设备自己的任务格式**。
 *
 * 一期协议（`task-protocol.ts`）描述的是一台差速底盘 + 六轴臂设备会听的七种动作，
 * 词汇表写死在那个文件里。RoboFrame 的设备不是那台机器——它听的是一串**技能调用**，
 * 每个技能在 `robot_config` 的 SSOT 里写着，可以随时增删。
 * 所以任务格式不能只有一份：**谁的设备，谁定任务长什么样**。
 *
 * 形状沿用前作集成设计稿 §7.3 的 `RobotTaskPlan`（那是要给 RoboFrame 的
 * `ExecuteTaskPlan` 消费的东西），三处偏离逐条记在这里：
 *
 * - **参数名照抄上游**。设计稿示例写的是 `motionDirection`，RoboFrame 的目录里是
 *   `motion_direction`（YAML 里的原名）。用真名，免得中间多一层没人维护的映射。
 * - **`step` 认 `'skill'` / `'if'` / `'wait'` / `'primitive'`**。设计稿的 `skipIf` 步这一版不做——
 *   它是「守卫挂在**后一步**上」，这一版换成这一步自己的 `onFailure`：两件事回答的是同一个问题
 *   （这一步失败之后计划怎么办），而写在这一步自己身上，读计划的人不必往后找那个守卫——
 *   **缺省仍是停**（见 `SkillStep.onFailure`）。**分支**要做：现实任务真的会分叉
 *   （上一步没成就换个法子再试），平铺的步骤列表表达不出来；**等待**也要做：技能自己带的时长
 *   管不了「两步之间停一下」（抓起来、等它稳定两秒、再移动）。**原语**也要做：目录里有些原子动作
 *   **没有**技能包装（`open_gripper` / `close_gripper` 这种），想直接叫它就得编一个假技能——
 *   `PrimitiveStep` 就是那条直路（见那个接口）。遇到不认的 step 给明确诊断，不静默当技能处理。
 *
 * **原语步（`primitive`）与技能步的关系**：形状与技能步**一模一样**（都是「叫一个东西去做事」，
 * 参数、`timeoutSec`、`onFailure` 三栏同待遇），差别只在**指名的方式**与**判据的来源**：
 * 技能步写 `skill`，判据是 `catalog.capabilities`；原语步写 `primitive`，判据是 `catalog.primitives`。
 * 参数校验因此**共用同一条路**（`validateCallStepParts`）——两份判据迟早分叉。
 * - **多一个 `description`**（可选）。设计稿的 plan 没有任务名（在 n8n 里节点自带名字），
 *   而这个界面上到处要显示「这是哪个任务」。不加就只能拿机器人名当任务名。
 *
 * **条件为什么只认 `last.success`**：计划是送给**机器**执行的，条件必须是机器身上真的能观测到的量。
 * 这台设备报上来的只有「上一步成没成」（它的 `recovery_policy` 也是照这一条写的），
 * 写别的字段等于让数据模型承诺一件执行侧兑现不了的事——校验器放行的东西，执行侧得能兑现。
 * 将来要加感知条件（比如夹爪里有没有东西），加的是**一个新的 `field`**（那时执行侧也真的会报这个量），
 * 而不是把这里放宽成「随便填」。
 *
 * 校验的判据是**目录**：技能（或原语）必须在目录里，参数必须是那个技能（或原语）声明过的、类型要对得上。
 * 目录就是设备报上来的那份，所以「能生成什么」和「能执行什么」永远是同一件事。
 */
import { DiagnosticCollector, type Diagnostic } from './diagnostic';
import { jsonDetail, type JsonObject, type JsonValue } from './json';
import {
	findCapability,
	findPrimitive,
	type CapabilityCatalog,
	type CapabilitySpec,
	type CatalogParameter,
} from './capability';

/** 计划格式的版本。整数，与设计稿一致（不是一期协议那种 `'1.0'` 字符串）。 */
export const SKILL_PLAN_SCHEMA_VERSION = 1;

/**
 * 计划步的种类全集。诊断里的 `supported` 与文档、提示词都照它说——
 * 加一种步就在这儿加一个名字，别处不许再抄一份。
 */
export const SKILL_PLAN_STEP_KINDS = ['skill', 'if', 'wait', 'primitive'] as const;

/** 分支条件的 `field` 全集。**要加感知条件就在这里加一个新 field**，不是放宽下面的判据。 */
export const BRANCH_CONDITION_FIELDS = ['last.success'] as const;

/** 分支条件的运算符全集。这一版只有等与不等——没有「大于」这种要有第二个量的算子。 */
export const BRANCH_CONDITION_OPS = ['==', '!='] as const;

/**
 * 分支嵌套上限定 8。
 * 递归校验与视图都要走这棵树，一份恶意嵌套的 JSON 不该能把它们打爆——
 * 正常人也不会写九层条件，所以这个上限是防弹衣，不是表达能力。
 */
export const SKILL_PLAN_MAX_BRANCH_DEPTH = 8;

/**
 * 一个 `wait` 步最多等多久（秒）：十分钟。
 *
 * 为什么要有这个上限：一条计划里塞个 86400 不是「等一天」，是把执行器挂在那儿——
 * 计划是送给机器执行的东西，一个数字就能让它整夜不动，它不该有这种表达力。
 * 真需要跨天，那是任务编排的事（分几次下发），不是这一步的事。
 */
export const SKILL_PLAN_MAX_WAIT_SECONDS = 600;

/**
 * 技能步失败之后怎么办的全集：`'stop'`（停）与 `'continue'`（往下走）。
 *
 * **只有这两个**：一个技能失败之后无非两种处置——整条计划停在这里，或者照计划往下走
 * （后面那一步自己按 `last.success` 决定要不要补救）。「重试」不在这一栏里：
 * 重试与否由技能自己的 `recovery_policy` 决定，不由计划替他拿主意（与 bridge 的纪律一致）。
 */
export const SKILL_PLAN_ON_FAILURE = ['stop', 'continue'] as const;

/** `onFailure` 的取值。缺省（没写这一栏）等价于 `'stop'`。 */
export type SkillPlanOnFailure = (typeof SKILL_PLAN_ON_FAILURE)[number];

/** 一个计划步：调一个技能。 */
export interface SkillStep {
	readonly step: 'skill';
	readonly skill: string;
	/** 技能参数；名字与取值类型由目录里那个技能的 `parameters` 规定。 */
	readonly params?: JsonObject;
	/** 这一步的超时（秒）。缺省时由执行侧按技能自己的 `recovery_policy` 定。 */
	readonly timeoutSec?: number;
	/**
	 * 这一步失败之后计划怎么办。**缺省是 `'stop'`**：失败即停，现在的行为一个字不变。
	 *
	 * **为什么默认是停**：这是安全立场，与 bridge「失败即停、不自动重试」同一条——
	 * 计划是送给**机器**执行的东西，默认改成 `'continue'` 等于让每一次技能失败之后
	 * 整台机器继续按计划动。要放宽必须是**写计划的人显式说的**（他才知道后面有没有可走的路）。
	 *
	 * `'continue'` 只改两件事：这一步失败之后计划继续往下走，且 `last.success` 记成 `false`
	 * （于是后面的 `if` 真的能走到「没成」那条臂）。它**不粉饰**：这一步照报 `failed`，
	 * 不算进 `completed`——失败是事实，被容忍也是事实，两件事各说各的。
	 *
	 * `wait` 与 `if` **不带**这一栏（等待不会失败；分支走哪条臂由条件决定），给了就报错。
	 * **`primitive` 步带它**，判据与待遇跟技能步完全一样（两者都是「叫一个东西去做事」）。
	 */
	readonly onFailure?: SkillPlanOnFailure;
}

/**
 * 一个计划步：**直接叫一个原子动作**，绕开技能那层包装。
 *
 * 为什么要有它：目录里有些原子动作**没有**对应的技能（SO-101 的 `open_gripper` / `close_gripper`
 * 就是这样——技能库里只有 `open_gripper_skill` 这类包装，而上游 `/embodied/execute_primitive`
 * 那条路本来就是直呼原语）。没有这一步，计划里想用它就只能**编一个假技能**：假技能不在目录里，
 * 校验器当场拒，编出来也用不了。
 *
 * 三条规矩，与技能步**同一条路**：
 * - `primitive` 必须是**当前设备目录 `catalog.primitives` 里的名字**（判据是目录，不是写死的表）。
 *   查不到报 `plan.step.primitive.unknown`，并把目录里有什么一并给上——与 `skill.unknown` 同一个写法；
 * - `params` 每个键必须是**那个原语声明的参数名**，类型要对得上；标了 `required: true` 的缺了是错误
 *   （`plan.step.param.required`），没标必填的缺了只提醒。这一段与技能步**共用同一个校验函数**；
 * - `timeoutSec` 与 `onFailure` 同技能步的待遇（`'stop'` 缺省 / `'continue'`），且它**真的会成会败**，
 *   所以参与 `last.success`。
 */
export interface PrimitiveStep {
	readonly step: 'primitive';
	/** 原语名（目录 `catalog.primitives[].primitiveRef` 里的原名）。 */
	readonly primitive: string;
	/** 原语参数；名字与取值类型由目录里那个原语的 `parameters` 规定。 */
	readonly params?: JsonObject;
	/** 这一步的超时（秒）。与技能步同一条口径（见 `SkillStep.timeoutSec`）。 */
	readonly timeoutSec?: number;
	/** 失败处置。缺省 `'stop'`；判据与待遇同技能步（见 `SkillStep.onFailure`）。 */
	readonly onFailure?: SkillPlanOnFailure;
}

/** 分支条件：机器身上唯一可靠的可观测量——**上一步成没成**（见文件头）。 */
export interface BranchCondition {
	readonly field: (typeof BRANCH_CONDITION_FIELDS)[number];
	readonly op: (typeof BRANCH_CONDITION_OPS)[number];
	readonly value: boolean;
}

/**
 * 一个计划步：按条件走一条臂。
 * `then` 至少一步；`else` 要么不给，要么至少一步（空臂没有意义，只会让执行侧猜）。
 * **没有 `onFailure`**：走哪条臂已经由条件说清了，再挂一个「失败怎么办」是无处安放的重复。
 */
export interface BranchStep {
	readonly step: 'if';
	readonly condition: BranchCondition;
	readonly then: readonly SkillPlanStep[];
	readonly else?: readonly SkillPlanStep[];
}

/**
 * 一个计划步：在这儿停一下，什么都不做。
 *
 * 三条规矩，都是「它是空的」这件事推出来的：
 * - **不改 `last.success`**：它没有「成」也没有「败」，所以它后面那个 `if` 看到的仍是
 *   `wait` **之前**那个技能步的结果（执行侧 `apps/robot3d/src/roboframe/plan.ts` 里钉着）；
 * - **秒数必须是正数**：0 秒的等待没有意义（那是在计划里塞一句废话），负数更不是等待；
 * - **有上限**（`SKILL_PLAN_MAX_WAIT_SECONDS`）：见那个常量的说明。
 *
 * **也没有 `onFailure`**：它不会失败（等不到点不是失败，是取消），所以「失败怎么办」这一栏
 * 在它身上没有对象——给了就报错，不静默忽略。
 */
export interface WaitStep {
	readonly step: 'wait';
	/** 等多少秒。正数，上限 `SKILL_PLAN_MAX_WAIT_SECONDS`。 */
	readonly seconds: number;
}

/**
 * 计划步：`SkillStep`（调一个技能）、`BranchStep`（按上一步的结果走一条臂）、
 * `WaitStep`（停一下）或 `PrimitiveStep`（直接叫一个原子动作）。
 * 四者可以互相嵌套——`BranchStep` 的两条臂装的还是这个联合。
 */
export type SkillPlanStep = SkillStep | BranchStep | WaitStep | PrimitiveStep;

export interface SkillPlan {
	readonly schemaVersion: number;
	/** 这是给哪台机器人编的计划：上游 `robot_config` 里的 `robot.name`。 */
	readonly robot: string;
	/** 任务名，给人看的。 */
	readonly description?: string;
	readonly plan: readonly SkillPlanStep[];
}

export interface ValidateSkillPlanOptions {
	/** 设备报上来的目录。技能与参数都照它判。 */
	readonly catalog: CapabilityCatalog;
	/** 计划要送给哪台机器人；目录知道自己的名字时，对不上就报出来。 */
	readonly expectedRobot?: string;
}

export type SkillPlanValidationResult =
	| { readonly ok: true; readonly plan: SkillPlan; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** 分支步没有 id，诊断的 `ref` 就用它自己的身份：`if`。 */
const BRANCH_STEP_REF = 'if';

/** `wait` 步同样没有 id，`ref` 就用它自己的身份：`wait`。 */
const WAIT_STEP_REF = 'wait';

/** 参数值是不是这个类型。`json` 收一切 JSON；`sensor` 是一串非空传感器路径。 */
const matchesType = (spec: CapabilitySpec['parameters'][number], value: JsonValue): boolean => {
	switch (spec.type) {
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) && (!spec.integer || Number.isInteger(value));
		case 'string':
		case 'pose':
			return typeof value === 'string';
		case 'boolean':
			return typeof value === 'boolean';
		case 'sensor':
			return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
		case 'json':
			return true;
	}
};

/** 展示用的一小段值：报错时让人看懂收到的是什么。 */
const show = (value: unknown): string => JSON.stringify(jsonDetail(value));

/** 是不是一个认得的失败处置（`'stop'` / `'continue'`）。 */
const isOnFailure = (value: unknown): value is SkillPlanOnFailure =>
	typeof value === 'string' && SKILL_PLAN_ON_FAILURE.some((allowed) => allowed === value);

/**
 * 技能步的失败处置：`undefined`（没写这一栏＝缺省 `'stop'`）或两个认得的取值之一，别的一律报错。
 *
 * 不认的取值**不退回缺省**：写 `'keep_going'` 的人想说的是「往下走」，静默按 `'stop'` 处理
 * 会让他的计划停在一步他以为不会停的地方——报出来，那句话才说得出口。
 */
const validateOnFailure = (
	rawStep: Record<string, unknown>,
	path: string,
	ref: string,
	collector: DiagnosticCollector,
): SkillPlanOnFailure | undefined => {
	const raw = rawStep['onFailure'];
	if (raw === undefined) return undefined;
	if (isOnFailure(raw)) return raw;
	collector.error({
		code: 'plan.step.onfailure_invalid',
		message: `失败处置只能是 ${SKILL_PLAN_ON_FAILURE.join(' / ')}（缺省是 stop），收到 ${show(raw)}`,
		path: `${path}.onFailure`,
		ref,
		details: { value: jsonDetail(raw), allowed: [...SKILL_PLAN_ON_FAILURE], default: 'stop' },
	});
	return undefined;
};

/**
 * `wait` 与 `if` **不带**失败处置：给了就报错（码 `plan.step.onfailure_not_applicable`）。
 *
 * 为什么是错误而不是「收下但没用」：这一栏在它们身上没有对象——等待不会失败，
 * 分支走哪条臂由条件决定。收下一个执行侧永远不会读的字段，等于让写计划的人以为它生效了。
 * **带这一栏的是技能步与原语步**（两者都是「叫一个东西去做事」），所以 `applicable` 是那两个。
 */
const rejectOnFailure = (
	rawStep: Record<string, unknown>,
	path: string,
	ref: string,
	message: string,
	collector: DiagnosticCollector,
): void => {
	if (rawStep['onFailure'] === undefined) return;
	collector.error({
		code: 'plan.step.onfailure_not_applicable',
		message,
		path: `${path}.onFailure`,
		ref,
		details: { value: jsonDetail(rawStep['onFailure']), applicable: ['skill', 'primitive'] },
	});
};

/**
 * 校验分支条件。
 *
 * 三条都**明确报错**，一条也不静默放行：将来加感知条件时加的是新的 `field`，
 * 而不是让不合法的输入从这道门里溜过去。
 */
const validateCondition = (raw: unknown, path: string, collector: DiagnosticCollector): BranchCondition | undefined => {
	if (!isPlainObject(raw)) {
		collector.error({
			code: 'plan.step.condition.not_object',
			message: '分支条件必须是一个对象',
			path,
			ref: BRANCH_STEP_REF,
			details: { value: jsonDetail(raw) },
		});
		return undefined;
	}

	let ok = true;

	const rawField = raw['field'];
	if (rawField !== 'last.success') {
		collector.error({
			code: 'plan.step.condition.field.unsupported',
			message: `分支条件这一版只认 ${BRANCH_CONDITION_FIELDS.join(' / ')}，收到 ${show(rawField)}`,
			path: `${path}.field`,
			ref: BRANCH_STEP_REF,
			details: { value: jsonDetail(rawField), allowed: [...BRANCH_CONDITION_FIELDS] },
		});
		ok = false;
	}

	const rawOp = raw['op'];
	let op: BranchCondition['op'] = '==';
	if (rawOp === '==' || rawOp === '!=') {
		op = rawOp;
	} else {
		collector.error({
			code: 'plan.step.condition.op.unsupported',
			message: `分支条件只支持 ${BRANCH_CONDITION_OPS.join(' / ')}，收到 ${show(rawOp)}`,
			path: `${path}.op`,
			ref: BRANCH_STEP_REF,
			details: { value: jsonDetail(rawOp), allowed: [...BRANCH_CONDITION_OPS] },
		});
		ok = false;
	}

	const rawValue = raw['value'];
	if (typeof rawValue !== 'boolean') {
		collector.error({
			code: 'plan.step.condition.value.invalid',
			message: '分支条件的取值只能是布尔（成功 / 没成功）',
			path: `${path}.value`,
			ref: BRANCH_STEP_REF,
			details: { value: jsonDetail(rawValue), expected: 'boolean' },
		});
		ok = false;
	}

	if (!ok || typeof rawValue !== 'boolean') return undefined;
	return { field: 'last.success', op, value: rawValue };
};

/** 一条臂：至少一步，元素是同一个联合。 */
const validateArm = (
	raw: unknown,
	path: string,
	code: string,
	message: string,
	depth: number,
	collector: DiagnosticCollector,
	catalog: CapabilityCatalog,
): readonly SkillPlanStep[] | undefined => {
	if (!Array.isArray(raw) || raw.length === 0) {
		collector.error({ code, message, path, ref: BRANCH_STEP_REF, details: { value: jsonDetail(raw) } });
		return undefined;
	}
	return validateSteps(raw, path, depth, collector, catalog);
};

/**
 * 校验一个 `if` 步。
 *
 * 深度按**祖先里有几层 `if`** 算：顶层 plan 里的 `if` 是第 1 层。超上限就**不再往下走**——
 * 恶意嵌套的代价是一层诊断，不是一次爆栈。同一层的另外两个问题（空的 `then` / 空的 `else`）
 * 照样报，让人一次看到全部。
 */
const validateBranchStep = (
	rawStep: Record<string, unknown>,
	path: string,
	depth: number,
	collector: DiagnosticCollector,
	catalog: CapabilityCatalog,
): BranchStep | undefined => {
	// 有没有那一栏与深度无关，所以先说它：深度超限时也不该把它咽掉。
	rejectOnFailure(
		rawStep,
		path,
		BRANCH_STEP_REF,
		'分支步不带 onFailure：走哪条臂由条件决定，「这一步失败了怎么办」在这儿没有对象',
		collector,
	);

	if (depth + 1 > SKILL_PLAN_MAX_BRANCH_DEPTH) {
		collector.error({
			code: 'plan.step.depth_exceeded',
			message: `分支最多嵌套 ${String(SKILL_PLAN_MAX_BRANCH_DEPTH)} 层，这里是第 ${String(depth + 1)} 层`,
			path,
			ref: BRANCH_STEP_REF,
			details: { depth: depth + 1, limit: SKILL_PLAN_MAX_BRANCH_DEPTH },
		});
		return undefined;
	}

	const condition = validateCondition(rawStep['condition'], `${path}.condition`, collector);
	const thenSteps = validateArm(
		rawStep['then'],
		`${path}.then`,
		'plan.step.if.then_empty',
		'分支的 then 至少要有一个步骤',
		depth + 1,
		collector,
		catalog,
	);
	const rawElse = rawStep['else'];
	const elseSteps =
		rawElse === undefined
			? undefined
			: validateArm(
					rawElse,
					`${path}.else`,
					'plan.step.if.else_empty',
					'分支的 else 要么不给，要么至少要有一个步骤',
					depth + 1,
					collector,
					catalog,
				);

	if (condition === undefined || thenSteps === undefined || (rawElse !== undefined && elseSteps === undefined)) {
		return undefined;
	}
	return { step: 'if', condition, then: thenSteps, ...(elseSteps === undefined ? {} : { else: elseSteps }) };
};

/** 一个「叫一个东西去做事」的步：参数、超时、失败处置这三段校验之后的产物。 */
interface CallStepParts {
	/** 只装**认得且类型对**的那些参数（没给的不补键，执行侧有默认值）。 */
	readonly params: JsonObject;
	readonly timeoutSec: number | undefined;
	readonly onFailure: SkillPlanOnFailure | undefined;
}

/**
 * 校验技能步与原语步**共用的那三段**：参数、`timeoutSec`、`onFailure`。
 *
 * 为什么必须共用：两边的规矩是同一套（名字必须是声明过的那些、类型要对得上、标了 `required`
 * 的缺了是错误、没标的缺了只提醒、超时是正数、失败处置只有两个取值），各写一份的结果是
 * **两份判据迟早分叉**——一边放宽一点，另一边的计划就悄悄溜过去了，而两条路在界面上长得一模一样。
 * 措辞里「被叫的那个东西」由 `subject` 给（`技能「wave_hello」` / `原语「open_gripper」`），
 * **码与判据一个字都不分叉**（同一个坏参数在两条路上给的是同一个码）。
 *
 * 检查顺序（诊断的先后顺序因此是稳定的）：参数是不是对象 → 逐个参数的认名与类型 →
 * 逐个声明的必填/缺失 → 超时 → 失败处置。
 */
const validateCallStepParts = (
	rawStep: Record<string, unknown>,
	path: string,
	options: {
		/** 被叫的那个东西的名字（技能名 / 原语名），进诊断的 `ref`。 */
		readonly ref: string;
		/** 措辞里的主语：`技能「x」` / `原语「x」`。 */
		readonly subject: string;
		/** 它声明的参数（判据来自目录，不是这里写的一张表）。 */
		readonly declared: readonly CatalogParameter[];
		readonly collector: DiagnosticCollector;
	},
): CallStepParts | undefined => {
	const { ref, subject, declared, collector } = options;

	const params = rawStep['params'] ?? {};
	if (!isPlainObject(params)) {
		collector.error({
			code: 'plan.step.params.not_object',
			message: `${subject}的参数必须是一个对象`,
			path: `${path}.params`,
			ref,
			details: { value: jsonDetail(params) },
		});
		return undefined;
	}

	const byName = new Map(declared.map((parameter) => [parameter.name, parameter]));
	const validated: JsonObject = {};
	/** 出现过的参数名（**不论取值合不合法**）——「缺参数」只对真的没出现的那些说。 */
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(params)) {
		const spec = byName.get(name);
		if (spec === undefined) {
			collector.error({
				code: 'plan.step.param.unknown',
				message: `${subject}没有参数「${name}」`,
				path: `${path}.params.${name}`,
				ref,
				details: { param: name, allowed: [...byName.keys()] },
			});
			continue;
		}
		seen.add(name);
		const asJson = jsonDetail(value);
		if (!matchesType(spec, asJson)) {
			collector.error({
				code: 'plan.step.param.type',
				message: `${subject}的参数「${name}」要 ${spec.type}，收到别的类型`,
				path: `${path}.params.${name}`,
				ref,
				details: { param: name, expected: spec.type, value: asJson },
			});
			continue;
		}
		validated[name] = asJson;
	}

	for (const [name, spec] of byName) {
		if (seen.has(name)) continue;
		// 上游说必填就是必填（技能的 JSON Schema 里有 `required` 数组），缺了是错误。
		if (spec.required === true) {
			collector.error({
				code: 'plan.step.param.required',
				message: `${subject}的「${name}」（${spec.label}）是必填的，这份计划没给`,
				path: `${path}.params`,
				ref,
				details: { param: name, expected: spec.type },
			});
			continue;
		}
		// 没标必填的缺了只提醒：执行侧有默认值。
		collector.warning({
			code: 'plan.step.param.missing',
			message: `${subject}没给参数「${name}」（${spec.label}），执行侧会用默认值`,
			path: `${path}.params`,
			ref,
			details: { param: name, expected: spec.type },
		});
	}

	const timeoutSec = rawStep['timeoutSec'];
	if (timeoutSec !== undefined && (typeof timeoutSec !== 'number' || !(timeoutSec > 0))) {
		collector.error({
			code: 'plan.step.timeout.invalid',
			message: '超时必须是正数（秒）',
			path: `${path}.timeoutSec`,
			ref,
			details: { value: jsonDetail(timeoutSec) },
		});
		return undefined;
	}

	return {
		params: validated,
		timeoutSec: typeof timeoutSec === 'number' ? timeoutSec : undefined,
		// 失败处置：缺省不给这一栏（＝执行侧按 `'stop'` 走，那时结果里也没有这个键）。
		onFailure: validateOnFailure(rawStep, path, ref, collector),
	};
};

/** 校验一个**技能**步：技能在不在目录里、参数名认不认、类型对不对。 */
const validateSkillStep = (
	rawStep: Record<string, unknown>,
	path: string,
	collector: DiagnosticCollector,
	catalog: CapabilityCatalog,
): SkillStep | undefined => {
	const rawSkill = rawStep['skill'];
	if (typeof rawSkill !== 'string' || rawSkill.trim() === '') {
		collector.error({ code: 'plan.step.skill.missing', message: '计划步必须写明技能名', path: `${path}.skill` });
		return undefined;
	}

	const capability = findCapability(catalog, rawSkill);
	if (capability === undefined) {
		collector.error({
			code: 'plan.step.skill.unknown',
			message: `目录「${catalog.displayName}」里没有技能「${rawSkill}」`,
			path: `${path}.skill`,
			ref: rawSkill,
			details: {
				value: rawSkill,
				catalog: catalog.catalogRef,
				revision: catalog.revisionRef,
				allowed: catalog.capabilities.map((item) => item.capabilityRef),
			},
		});
		return undefined;
	}

	const parts = validateCallStepParts(rawStep, path, {
		ref: rawSkill,
		subject: `技能「${rawSkill}」`,
		declared: capability.parameters,
		collector,
	});
	if (parts === undefined) return undefined;

	return {
		step: 'skill',
		skill: rawSkill,
		...(Object.keys(parts.params).length === 0 ? {} : { params: parts.params }),
		...(parts.timeoutSec === undefined ? {} : { timeoutSec: parts.timeoutSec }),
		...(parts.onFailure === undefined ? {} : { onFailure: parts.onFailure }),
	};
};

/**
 * 校验一个**原语**步：原语在不在目录里（不在就把目录里有什么一并给上）、参数与技能步同一条路。
 *
 * 判据是**目录**（`catalog.primitives`），不是写死的表——设备报上来的原语可以随时增删，
 * 写死一张表等于让「能生成什么」与「能执行什么」分家。查不到时的诊断形状照 `skill.unknown` 抄。
 */
const validatePrimitiveStep = (
	rawStep: Record<string, unknown>,
	path: string,
	collector: DiagnosticCollector,
	catalog: CapabilityCatalog,
): PrimitiveStep | undefined => {
	const rawPrimitive = rawStep['primitive'];
	if (typeof rawPrimitive !== 'string' || rawPrimitive.trim() === '') {
		collector.error({ code: 'plan.step.primitive.missing', message: '原语步必须写明原语名', path: `${path}.primitive` });
		return undefined;
	}

	const primitive = findPrimitive(catalog, rawPrimitive);
	if (primitive === undefined) {
		collector.error({
			code: 'plan.step.primitive.unknown',
			message: `目录「${catalog.displayName}」里没有原语「${rawPrimitive}」`,
			path: `${path}.primitive`,
			ref: rawPrimitive,
			details: {
				value: rawPrimitive,
				catalog: catalog.catalogRef,
				revision: catalog.revisionRef,
				allowed: catalog.primitives.map((item) => item.primitiveRef),
			},
		});
		return undefined;
	}

	const parts = validateCallStepParts(rawStep, path, {
		ref: rawPrimitive,
		subject: `原语「${rawPrimitive}」`,
		declared: primitive.parameters,
		collector,
	});
	if (parts === undefined) return undefined;

	return {
		step: 'primitive',
		primitive: rawPrimitive,
		...(Object.keys(parts.params).length === 0 ? {} : { params: parts.params }),
		...(parts.timeoutSec === undefined ? {} : { timeoutSec: parts.timeoutSec }),
		...(parts.onFailure === undefined ? {} : { onFailure: parts.onFailure }),
	};
};

/**
 * 校验一个 `wait` 步：秒数必须是正数，且不超 `SKILL_PLAN_MAX_WAIT_SECONDS`。
 *
 * 两种毛病给**两个码**：「这个数不对」（0 / 负数 / 字符串 / 压根没给）与「这个数太大」，
 * 界面上是两句不同的话，混成一个码就只能说一句含糊的。
 * 它也**不参与深度计数**：深度上限数的是 `if` 的嵌套（见 `validateBranchStep`），
 * 而等待不是一层结构——把它算进去，等于让「等一会儿」占掉分支的表达空间。
 */
const validateWaitStep = (
	rawStep: Record<string, unknown>,
	path: string,
	collector: DiagnosticCollector,
): WaitStep | undefined => {
	rejectOnFailure(
		rawStep,
		path,
		WAIT_STEP_REF,
		'等待步不带 onFailure：它不会失败（等多久由 seconds 决定）',
		collector,
	);

	const rawSeconds = rawStep['seconds'];
	if (typeof rawSeconds !== 'number' || !Number.isFinite(rawSeconds) || !(rawSeconds > 0)) {
		collector.error({
			code: 'plan.step.wait.seconds_invalid',
			message: '等待的秒数必须是正数',
			path: `${path}.seconds`,
			ref: WAIT_STEP_REF,
			details: { value: jsonDetail(rawSeconds), expected: 'number > 0' },
		});
		return undefined;
	}

	if (rawSeconds > SKILL_PLAN_MAX_WAIT_SECONDS) {
		collector.error({
			code: 'plan.step.wait.seconds_out_of_range',
			message: `等待最多 ${String(SKILL_PLAN_MAX_WAIT_SECONDS)} 秒（十分钟），收到 ${String(rawSeconds)} 秒`,
			path: `${path}.seconds`,
			ref: WAIT_STEP_REF,
			details: { value: rawSeconds, limit: SKILL_PLAN_MAX_WAIT_SECONDS },
		});
		return undefined;
	}

	return { step: 'wait', seconds: rawSeconds };
};

/** 校验一个计划步（顶层与臂里都是这一条路）。通了返回规范化之后的那一步，不通给 `undefined`。 */
const validateStep = (
	rawStep: unknown,
	path: string,
	depth: number,
	collector: DiagnosticCollector,
	catalog: CapabilityCatalog,
): SkillPlanStep | undefined => {
	if (!isPlainObject(rawStep)) {
		collector.error({ code: 'plan.step.not_object', message: '计划步必须是一个对象', path });
		return undefined;
	}

	const stepKind = rawStep['step'];
	if (stepKind === 'skill') return validateSkillStep(rawStep, path, collector, catalog);
	if (stepKind === 'if') return validateBranchStep(rawStep, path, depth, collector, catalog);
	if (stepKind === 'wait') return validateWaitStep(rawStep, path, collector);
	if (stepKind === 'primitive') return validatePrimitiveStep(rawStep, path, collector, catalog);

	// 别的步这一版不做——明说，不静默当成技能。
	collector.error({
		code: 'plan.step.kind_unsupported',
		message:
			stepKind === undefined
				? '计划步缺少 step 字段'
				: `这一版只认 step: ${SKILL_PLAN_STEP_KINDS.map((kind) => `"${kind}"`).join(' / ')}，收到 ${JSON.stringify(stepKind)}（设计稿的 skipIf 还没做：它是把守卫挂在后一步上，这一版换成这一步自己的 onFailure）`,
		path: `${path}.step`,
		details: { value: jsonDetail(stepKind), supported: [...SKILL_PLAN_STEP_KINDS] },
	});
	return undefined;
};

/**
 * 校验一串计划步：顶层 `plan` 或某条臂（臂里装的还是同一个联合）。
 *
 * `depth` 是这一层**已经有几层 `if` 祖先**，一路往下带，深度上限只在 `if` 那一步判。
 *
 * 分支后面**可以**再跟同层步骤：结构化语句里 `if` 执行完了本来就接着往下走，
 * 与走了哪一条臂无关。这一版在计划层不做汇合（两条臂各自收尾，不回到同一点），
 * 「分支之后的那些步」由声明侧单独接在分支节点上（见 `@codecanvas/task-import` 的第三格），
 * 所以这里不需要任何额外规矩——校验器只认「步骤合法 + 嵌套有界」。
 */
const validateSteps = (
	raw: readonly unknown[],
	basePath: string,
	depth: number,
	collector: DiagnosticCollector,
	catalog: CapabilityCatalog,
): SkillPlanStep[] => {
	const steps: SkillPlanStep[] = [];
	raw.forEach((rawStep, index) => {
		const step = validateStep(rawStep, `${basePath}[${String(index)}]`, depth, collector, catalog);
		if (step !== undefined) steps.push(step);
	});
	return steps;
};

/**
 * 校验一份技能计划。**不抛异常**：一次跑完，把能带定位的问题全报出来（spec §2 的纪律）。
 *
 * 检查顺序与一期协议的校验器一致：整体形状 → 版本 → 机器人 → 逐步（分支再递归进两条臂）。
 */
export const validateSkillPlan = (
	input: unknown,
	options: ValidateSkillPlanOptions,
): SkillPlanValidationResult => {
	const collector = new DiagnosticCollector();
	const { catalog } = options;

	if (!isPlainObject(input)) {
		collector.error({ code: 'plan.not_object', message: '计划必须是一个对象' });
		return { ok: false, diagnostics: collector.diagnostics };
	}

	if (input['schemaVersion'] !== SKILL_PLAN_SCHEMA_VERSION) {
		collector.error({
			code: 'plan.schema_version.unsupported',
			message: `计划版本必须是 ${String(SKILL_PLAN_SCHEMA_VERSION)}`,
			path: 'schemaVersion',
			details: { value: jsonDetail(input['schemaVersion']), expected: SKILL_PLAN_SCHEMA_VERSION },
		});
	}

	const rawRobot = input['robot'];
	if (typeof rawRobot !== 'string' || rawRobot.trim() === '') {
		collector.error({ code: 'plan.robot.missing', message: '计划必须写明给哪台机器人', path: 'robot' });
	} else if (options.expectedRobot !== undefined && rawRobot !== options.expectedRobot) {
		collector.error({
			code: 'plan.robot.mismatch',
			message: `计划是给「${rawRobot}」编的，当前设备是「${options.expectedRobot}」`,
			path: 'robot',
			details: { value: rawRobot, expected: options.expectedRobot },
		});
	}

	const rawDescription = input['description'];
	if (rawDescription !== undefined && (typeof rawDescription !== 'string' || rawDescription.trim() === '')) {
		collector.error({
			code: 'plan.description.invalid',
			message: '任务名要给就给一个非空字符串',
			path: 'description',
			details: { value: jsonDetail(rawDescription) },
		});
	}

	const rawPlan = input['plan'];
	if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
		collector.error({
			code: 'plan.steps.missing',
			message: '计划至少要有一个步骤',
			path: 'plan',
			details: { value: jsonDetail(rawPlan) },
		});
		return { ok: false, diagnostics: collector.diagnostics };
	}

	const steps = validateSteps(rawPlan, 'plan', 0, collector, catalog);

	if (collector.hasErrors) {
		return { ok: false, diagnostics: collector.diagnostics };
	}

	const robot = typeof rawRobot === 'string' ? rawRobot : '';
	return {
		ok: true,
		plan: {
			schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
			robot,
			...(typeof rawDescription === 'string' ? { description: rawDescription } : {}),
			plan: steps,
		},
		diagnostics: collector.diagnostics,
	};
};

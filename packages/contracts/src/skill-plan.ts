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
 * - **`step` 认 `'skill'` 与 `'if'`**。设计稿的 `primitive` / `wait` / `skipIf` 步这一版不做——
 *   它们要在流程画布上各自长成一种模块，而现在画布上的模块就是「调一个能力」；
 *   但**分支**要做：现实任务真的会分叉（上一步没成就换个法子再试），平铺的步骤列表
 *   表达不出来。遇到不认的 step 给明确诊断，不静默当技能处理。
 * - **多一个 `description`**（可选）。设计稿的 plan 没有任务名（在 n8n 里节点自带名字），
 *   而这个界面上到处要显示「这是哪个任务」。不加就只能拿机器人名当任务名。
 *
 * **条件为什么只认 `last.success`**：计划是送给**机器**执行的，条件必须是机器身上真的能观测到的量。
 * 这台设备报上来的只有「上一步成没成」（它的 `recovery_policy` 也是照这一条写的），
 * 写别的字段等于让数据模型承诺一件执行侧兑现不了的事——校验器放行的东西，执行侧得能兑现。
 * 将来要加感知条件（比如夹爪里有没有东西），加的是**一个新的 `field`**（那时执行侧也真的会报这个量），
 * 而不是把这里放宽成「随便填」。
 *
 * 校验的判据是**目录**：技能必须在目录里，参数必须是那个技能声明过的、类型要对得上。
 * 目录就是设备报上来的那份，所以「能生成什么」和「能执行什么」永远是同一件事。
 */
import { DiagnosticCollector, type Diagnostic } from './diagnostic';
import { jsonDetail, type JsonObject, type JsonValue } from './json';
import { findCapability, type CapabilityCatalog, type CapabilitySpec } from './capability';

/** 计划格式的版本。整数，与设计稿一致（不是一期协议那种 `'1.0'` 字符串）。 */
export const SKILL_PLAN_SCHEMA_VERSION = 1;

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

/** 一个计划步：调一个技能。 */
export interface SkillStep {
	readonly step: 'skill';
	readonly skill: string;
	/** 技能参数；名字与取值类型由目录里那个技能的 `parameters` 规定。 */
	readonly params?: JsonObject;
	/** 这一步的超时（秒）。缺省时由执行侧按技能自己的 `recovery_policy` 定。 */
	readonly timeoutSec?: number;
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
 */
export interface BranchStep {
	readonly step: 'if';
	readonly condition: BranchCondition;
	readonly then: readonly SkillPlanStep[];
	readonly else?: readonly SkillPlanStep[];
}

/**
 * 计划步：`SkillStep`（调一个技能）或 `BranchStep`（按上一步的结果走一条臂）。
 * 两者可以互相嵌套——`BranchStep` 的两条臂装的还是这个联合。
 */
export type SkillPlanStep = SkillStep | BranchStep;

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

	const params = rawStep['params'] ?? {};
	if (!isPlainObject(params)) {
		collector.error({
			code: 'plan.step.params.not_object',
			message: '技能参数必须是一个对象',
			path: `${path}.params`,
			ref: rawSkill,
			details: { value: jsonDetail(params) },
		});
		return undefined;
	}

	const declared = new Map(capability.parameters.map((parameter) => [parameter.name, parameter]));
	const validated: JsonObject = {};
	/** 出现过的参数名（**不论取值合不合法**）——「缺参数」只对真的没出现的那些说。 */
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(params)) {
		const spec = declared.get(name);
		if (spec === undefined) {
			collector.error({
				code: 'plan.step.param.unknown',
				message: `技能「${rawSkill}」没有参数「${name}」`,
				path: `${path}.params.${name}`,
				ref: rawSkill,
				details: { param: name, allowed: [...declared.keys()] },
			});
			continue;
		}
		seen.add(name);
		const asJson = jsonDetail(value);
		if (!matchesType(spec, asJson)) {
			collector.error({
				code: 'plan.step.param.type',
				message: `技能「${rawSkill}」的参数「${name}」要 ${spec.type}，收到别的类型`,
				path: `${path}.params.${name}`,
				ref: rawSkill,
				details: { param: name, expected: spec.type, value: asJson },
			});
			continue;
		}
		validated[name] = asJson;
	}

	for (const [name, spec] of declared) {
		if (seen.has(name)) continue;
		// 上游说必填就是必填（技能的 JSON Schema 里有 `required` 数组），缺了是错误。
		if (spec.required === true) {
			collector.error({
				code: 'plan.step.param.required',
				message: `技能「${rawSkill}」的「${name}」（${spec.label}）是必填的，这份计划没给`,
				path: `${path}.params`,
				ref: rawSkill,
				details: { param: name, expected: spec.type },
			});
			continue;
		}
		// 没标必填的缺了只提醒：执行侧有默认值。
		collector.warning({
			code: 'plan.step.param.missing',
			message: `技能「${rawSkill}」没给参数「${name}」（${spec.label}），执行侧会用默认值`,
			path: `${path}.params`,
			ref: rawSkill,
			details: { param: name, expected: spec.type },
		});
	}

	const timeoutSec = rawStep['timeoutSec'];
	if (timeoutSec !== undefined && (typeof timeoutSec !== 'number' || !(timeoutSec > 0))) {
		collector.error({
			code: 'plan.step.timeout.invalid',
			message: '超时必须是正数（秒）',
			path: `${path}.timeoutSec`,
			ref: rawSkill,
			details: { value: jsonDetail(timeoutSec) },
		});
		return undefined;
	}

	return {
		step: 'skill',
		skill: rawSkill,
		...(Object.keys(validated).length === 0 ? {} : { params: validated }),
		...(typeof timeoutSec === 'number' ? { timeoutSec } : {}),
	};
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

	// 别的步这一版不做——明说，不静默当成技能。
	collector.error({
		code: 'plan.step.kind_unsupported',
		message:
			stepKind === undefined
				? '计划步缺少 step 字段'
				: `这一版只认 step: "skill" / "if"，收到 ${JSON.stringify(stepKind)}（primitive / wait / skipIf 还没做）`,
		path: `${path}.step`,
		details: { value: jsonDetail(stepKind), supported: ['skill', 'if'] },
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

/**
 * RoboFrame 的技能计划：**这台设备自己的任务格式**。
 *
 * 一期协议（`task-protocol.ts`）描述的是一台差速底盘 + 六轴臂设备会听的七种动作，
 * 词汇表写死在那个文件里。RoboFrame 的设备不是那台机器——它听的是一串**技能调用**，
 * 每个技能在 `robot_config` 的 SSOT 里写着，可以随时增删。
 * 所以任务格式不能只有一份：**谁的设备，谁定任务长什么样**。
 *
 * 形状沿用前作集成设计稿 §7.3 的 `RobotTaskPlan`（那是要给 RoboFrame 的
 * `ExecuteTaskPlan` 消费的东西），两处偏离逐条记在这里：
 *
 * - **参数名照抄上游**。设计稿示例写的是 `motionDirection`，RoboFrame 的目录里是
 *   `motion_direction`（YAML 里的原名）。用真名，免得中间多一层没人维护的映射。
 * - **`step` 只认 `'skill'`**。设计稿的 `primitive` / `wait` / `skipIf` 步这一版不做——
 *   它们要在流程画布上各自长成一种模块，而现在画布上的模块就是「调一个能力」。
 *   遇到不认的 step 给明确诊断，不静默当技能处理。
 * - **多一个 `description`**（可选）。设计稿的 plan 没有任务名（在 n8n 里节点自带名字），
 *   而这个界面上到处要显示「这是哪个任务」。不加就只能拿机器人名当任务名。
 *
 * 校验的判据是**目录**：技能必须在目录里，参数必须是那个技能声明过的、类型要对得上。
 * 目录就是设备报上来的那份，所以「能生成什么」和「能执行什么」永远是同一件事。
 */
import { DiagnosticCollector, type Diagnostic } from './diagnostic';
import { jsonDetail, type JsonObject, type JsonValue } from './json';
import { findCapability, type CapabilityCatalog, type CapabilitySpec } from './capability';

/** 计划格式的版本。整数，与设计稿一致（不是一期协议那种 `'1.0'` 字符串）。 */
export const SKILL_PLAN_SCHEMA_VERSION = 1;

/** 一个计划步：调一个技能。 */
export interface SkillPlanStep {
	readonly step: 'skill';
	readonly skill: string;
	/** 技能参数；名字与取值类型由目录里那个技能的 `parameters` 规定。 */
	readonly params?: JsonObject;
	/** 这一步的超时（秒）。缺省时由执行侧按技能自己的 `recovery_policy` 定。 */
	readonly timeoutSec?: number;
}

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

/**
 * 校验一份技能计划。**不抛异常**：一次跑完，把能带定位的问题全报出来（spec §2 的纪律）。
 *
 * 检查顺序与一期协议的校验器一致：整体形状 → 版本 → 机器人 → 逐步。
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

	const steps: SkillPlanStep[] = [];
	rawPlan.forEach((rawStep, index) => {
		const path = `plan[${String(index)}]`;
		if (!isPlainObject(rawStep)) {
			collector.error({ code: 'plan.step.not_object', message: '计划步必须是一个对象', path });
			return;
		}

		const stepKind = rawStep['step'];
		if (stepKind !== 'skill') {
			// 别的步这一版不做——明说，不静默当成技能。
			collector.error({
				code: 'plan.step.kind_unsupported',
				message:
					stepKind === undefined
						? '计划步缺少 step 字段'
						: `这一版只认 step: "skill"，收到 ${JSON.stringify(stepKind)}（primitive / wait / skipIf 还没做）`,
				path: `${path}.step`,
				details: { value: jsonDetail(stepKind), supported: ['skill'] },
			});
			return;
		}

		const rawSkill = rawStep['skill'];
		if (typeof rawSkill !== 'string' || rawSkill.trim() === '') {
			collector.error({ code: 'plan.step.skill.missing', message: '计划步必须写明技能名', path: `${path}.skill` });
			return;
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
			return;
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
			return;
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
			// 目录没标必填（`catalogParameterSchema` 没有 required 这一栏），所以缺参数只提醒不拦。
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
			return;
		}

		steps.push({
			step: 'skill',
			skill: rawSkill,
			...(Object.keys(validated).length === 0 ? {} : { params: validated }),
			...(typeof timeoutSec === 'number' ? { timeoutSec } : {}),
		});
	});

	if (collector.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
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

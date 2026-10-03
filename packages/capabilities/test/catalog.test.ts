/**
 * 能力目录的自检。
 *
 * 目录有三份：`phase1-robot.ts`（手写的示意目录）、`roboframe/` 里两台真实配置转出来的目录
 * （SO-101 单臂，以及腕装 RealSense 的抓取配置）。所以这里分两层：
 *
 * - **共同定律**（`describe.each`）：三份目录都适用的几条容易写歪的事——
 *   符合契约 schema、实现里引用的原语真的存在（**递归遍历语句树**，含 if 的两个分支）、
 *   每个 `{kind:'param'}` 都能解析（局部变量或本能力参数）、实参名确实是那个原语声明的参数名、
 *   委托的实参名确实是这个能力声明的参数名。这一层就是接真实数据时的**接收闸**。
 * - **各自的实情**：一期目录要覆盖协议七种动作；单臂目录要覆盖上游那份技能表与白名单、
 *   记着它从哪儿来（上游 commit）、几处上游语义确实被搬对了（夹爪归一化会在最前面插一条、
 *   `*_from_request` 落成参数引用而不是写死的值）；抓取目录要有一条**实现在执行侧**的技能
 *   （`pick_object` → `/manipulation/execute_pick`），且这份 `delegate` 不许污染原语白名单。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	type CapabilityCatalog,
	type CapabilitySpec,
	type ImplArgument,
	type ImplExpression,
	type ImplStatement,
	capabilityCatalogSchema,
	findPrimitive,
	sha256Hex,
} from '@codecanvas/contracts';
import {
	PHASE1_ROBOT_CATALOG,
	ROBOFRAME_GRASP_CATALOG,
	ROBOFRAME_GRASP_PROVENANCE,
	ROBOFRAME_SO101_CATALOG,
	ROBOFRAME_SO101_PROVENANCE,
} from '../src/index';

/** 深度优先遍历语句树里的每条语句。 */
const eachStatement = (statements: readonly ImplStatement[], visit: (s: ImplStatement) => void): void => {
	for (const statement of statements) {
		visit(statement);
		if (statement.kind === 'if') {
			eachStatement(statement.then, visit);
			if (statement.else !== undefined) eachStatement(statement.else, visit);
		}
	}
};

/** 深度优先遍历表达式树。 */
const eachExpression = (expression: ImplExpression, visit: (e: ImplExpression) => void): void => {
	visit(expression);
	if (expression.kind === 'binary') {
		eachExpression(expression.left, visit);
		eachExpression(expression.right, visit);
	}
	if (expression.kind === 'unary') eachExpression(expression.value, visit);
};

/** 走进任意实参：字面量就到头，表达式继续下钻。 */
const eachArgument = (argument: ImplArgument, visit: (e: ImplExpression) => void): void => {
	if (typeof argument === 'object' && !Array.isArray(argument) && 'kind' in argument) {
		eachExpression(argument, visit);
	}
};

/** 每条语句里出现的所有表达式（含实参里的；委托的实参也是实参）。 */
const expressionsOf = (statement: ImplStatement): ImplExpression[] => {
	const found: ImplExpression[] = [];
	const collectArgs = (args: Record<string, ImplArgument>) => {
		for (const argument of Object.values(args)) eachArgument(argument, (e) => found.push(e));
	};
	if (statement.kind === 'call') collectArgs(statement.arguments);
	if (statement.kind === 'delegate') collectArgs(statement.arguments);
	if (statement.kind === 'set') found.push(statement.value);
	if (statement.kind === 'if') found.push(statement.condition);
	return found;
};

const statementArguments = (statement: ImplStatement): Record<string, ImplArgument> | null =>
	statement.kind === 'call' ? statement.arguments : null;

/**
 * 委托的实参。**不**复用 `statementArguments`：那两个的实参名要对着**原语**声明的参数查，
 * 而委托指向的是执行侧的接口——接口的签名不在目录里（目录里只有这台设备的原语）。
 * 能查、也该查的是：委托传的每个实参名，必须是**这个能力自己声明的参数**——
 * 「取值来自技能的参数」这条链要是断了，界面上的 delegate 就只是一个死字符串。
 */
const delegateArguments = (statement: ImplStatement): Record<string, ImplArgument> | null =>
	statement.kind === 'delegate' ? statement.arguments : null;

/** 实参是不是写死的字面量；是就取出它的值（结构化载荷在断言里要能直接看）。 */
const literalValueOf = (argument: ImplArgument | undefined): unknown => {
	if (typeof argument !== 'object' || argument === null || Array.isArray(argument)) return undefined;
	return argument.kind === 'literal' ? argument.value : undefined;
};

const localsOf = (capability: CapabilitySpec): Set<string> => {
	const locals = new Set<string>();
	eachStatement(capability.implementation, (statement) => {
		if (statement.kind === 'set') locals.add(statement.target);
	});
	return locals;
};

const CATALOGS: readonly { readonly name: string; readonly catalog: CapabilityCatalog }[] = [
	{ name: '一期设备目录（示意实现）', catalog: PHASE1_ROBOT_CATALOG },
	{ name: 'RoboFrame SO-101 目录（上游真实技能库）', catalog: ROBOFRAME_SO101_CATALOG },
	{ name: 'RoboFrame 抓取目录（腕装 RealSense）', catalog: ROBOFRAME_GRASP_CATALOG },
];

describe.each(CATALOGS)('$name', ({ catalog }) => {
	it('符合契约 schema', () => {
		const parsed = capabilityCatalogSchema.safeParse(catalog);
		if (!parsed.success) {
			throw new Error(`catalog invalid: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
		}
		expect(parsed.success).toBe(true);
	});

	it('实现里引用的原语都存在（含 if 分支里的）', () => {
		for (const capability of catalog.capabilities) {
			eachStatement(capability.implementation, (statement) => {
				const refs: string[] = [];
				if (statement.kind === 'call') refs.push(statement.primitiveRef);
				if (statement.kind === 'set') {
					eachExpression(statement.value, (e) => {
						if (e.kind === 'call') refs.push(e.primitiveRef);
					});
				}
				for (const ref of refs) {
					expect(
						findPrimitive(catalog, ref),
						`${capability.capabilityRef} 引用了不存在的原语 ${ref}`,
					).toBeDefined();
				}
			});
		}
	});

	it('每个 param 引用都能解析（局部变量或能力参数）', () => {
		for (const capability of catalog.capabilities) {
			const locals = localsOf(capability);
			const parameters = new Set(capability.parameters.map((parameter) => parameter.name));
			const unresolved: string[] = [];
			const check = (e: ImplExpression): void => {
				eachExpression(e, (node) => {
					if (node.kind === 'param' && !locals.has(node.name) && !parameters.has(node.name)) {
						unresolved.push(`${capability.capabilityRef} → ${node.name}`);
					}
				});
			};
			eachStatement(capability.implementation, (statement) => {
				for (const expression of expressionsOf(statement)) {
					check(expression);
					// 实参里嵌的表达式也要查
					eachExpression(expression, (node) => {
						if (node.kind !== 'call') return;
						for (const argument of Object.values(node.arguments)) eachArgument(argument, check);
					});
				}
			});
			expect(unresolved).toEqual([]);
		}
	});

	it('实参名必须是该原语声明的参数名', () => {
		for (const capability of catalog.capabilities) {
			eachStatement(capability.implementation, (statement) => {
				const args = statementArguments(statement);
				if (args === null) return;
				const primitive = findPrimitive(catalog, statement.kind === 'call' ? statement.primitiveRef : '');
				if (primitive === undefined) return;
				const declared = new Set(primitive.parameters.map((parameter) => parameter.name));
				for (const key of Object.keys(args)) {
					expect(
						declared.has(key),
						`${capability.capabilityRef} → ${primitive.primitiveRef} 传了未声明的实参 ${key}`,
					).toBe(true);
				}
			});
		}
	});

	it('委托的实参名必须是这个能力声明的参数名，且 interfaceRef 不冒充原语', () => {
		for (const capability of catalog.capabilities) {
			const declared = new Set(capability.parameters.map((parameter) => parameter.name));
			eachStatement(capability.implementation, (statement) => {
				const args = delegateArguments(statement);
				if (args === null) return;
				if (statement.kind !== 'delegate') throw new Error('预期是委托');
				for (const key of Object.keys(args)) {
					expect(
						declared.has(key),
						`${capability.capabilityRef} 委托给 ${statement.interfaceRef} 时传了本能力没声明的实参 ${key}`,
					).toBe(true);
				}
				// 实现在执行侧，所以 `interfaceRef` 不是本目录里的原语——一旦它在 `primitives` 里
				// 找得到，说明有人把接口名当原语塞进了白名单（`skill_library` 的那十个词是白名单）。
				expect(
					findPrimitive(catalog, statement.interfaceRef),
					`${capability.capabilityRef} 的 interfaceRef ${statement.interfaceRef} 不该是一个原语`,
				).toBeUndefined();
			});
		}
	});

	it('每个能力的实现都非空（穿透才有东西可看）', () => {
		for (const capability of catalog.capabilities) {
			expect(capability.implementation.length, capability.capabilityRef).toBeGreaterThan(0);
		}
	});
});

describe('一期设备目录的实情', () => {
	const catalog = PHASE1_ROBOT_CATALOG;

	it('一期协议的七种动作都在目录里', () => {
		const refs = catalog.capabilities.map((capability) => capability.capabilityRef);
		for (const action of ['move', 'turn', 'stop', 'stop_if_obstacle', 'get_status', 'arm_joint', 'arm6_joints']) {
			expect(refs, `missing capability: ${action}`).toContain(action);
		}
	});

	it('至少有一个能力带条件分支（树结构不是摆设）', () => {
		const withBranch = catalog.capabilities.filter((capability) => {
			let found = false;
			eachStatement(capability.implementation, (statement) => {
				if (statement.kind === 'if') found = true;
			});
			return found;
		});
		expect(withBranch.map((capability) => capability.capabilityRef)).toContain('stop_if_obstacle');
	});
});

describe('RoboFrame SO-101 目录的实情', () => {
	const catalog = ROBOFRAME_SO101_CATALOG;
	const implementationOf = (capabilityRef: string): readonly ImplStatement[] => {
		const capability = catalog.capabilities.find((item) => item.capabilityRef === capabilityRef);
		if (capability === undefined) throw new Error(`目录里没有 ${capabilityRef}`);
		return capability.implementation;
	};

	it('带出了它在上游的出处（数据不是凭空来的）', () => {
		expect(ROBOFRAME_SO101_PROVENANCE.upstream).toContain('IB_Robot');
		expect(ROBOFRAME_SO101_PROVENANCE.branch).toBe('RoboFrame');
		expect(ROBOFRAME_SO101_PROVENANCE.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(ROBOFRAME_SO101_PROVENANCE.robotConfig).toContain('so101_single_arm.yaml');
	});

	it('上游 skill_library 白名单里的十个原语都在', () => {
		const refs = catalog.primitives.map((primitive) => primitive.primitiveRef);
		for (const primitive of [
			'move_to_named_pose',
			'move_to_pose',
			'move_to_configuration',
			'move_relative_ee',
			'move_to_joint_positions',
			'move_through_joint_positions',
			'open_gripper',
			'close_gripper',
			'rotate_gripper_cw',
			'rotate_gripper_ccw',
		]) {
			expect(refs, `missing primitive: ${primitive}`).toContain(primitive);
		}
	});

	it('上游 so101_single_arm.yaml 的十六个技能都在，且中文别名当了 label', () => {
		const refs = catalog.capabilities.map((capability) => capability.capabilityRef);
		for (const skill of [
			'inspect_scene',
			'recover_safe_pose',
			'recover_zero_pose',
			'move_relative_ee',
			'open_gripper_skill',
			'close_gripper_skill',
			'rotate_gripper_cw',
			'rotate_gripper_ccw',
			'dance_basic',
			'wave_hello',
			'nod_yes',
			'shake_no',
			'celebrate',
			'greet_observe_raise',
			'act_cute',
			'happy_spin_upright',
		]) {
			expect(refs, `missing skill: ${skill}`).toContain(skill);
		}
		expect(catalog.capabilities.find((item) => item.capabilityRef === 'wave_hello')?.label).toBe('打招呼');
	});

	it('参数的**单位**与**必填**来自上游 JSON Schema，不是我们补的', () => {
		// 上游 `capability.parameters` 里 `motion_distance` 带 `unit: meters`、
		// `required: [motion_direction, motion_distance]`。这两样曾经在导入时被丢掉，
		// 结果是界面上没有单位、「必填」这条约束降级成一句含糊的提醒。
		const relative = catalog.capabilities.find((item) => item.capabilityRef === 'move_relative_ee');
		const byName = new Map((relative?.parameters ?? []).map((parameter) => [parameter.name, parameter]));
		expect(byName.get('motion_distance')?.unit).toBe('meters');
		expect(byName.get('motion_direction')?.required).toBe(true);
		expect(byName.get('motion_distance')?.required).toBe(true);

		// 单位跟着技能走：旋转那两个是「度」，不是「米」。
		const rotate = catalog.capabilities.find((item) => item.capabilityRef === 'rotate_gripper_cw');
		expect(rotate?.parameters[0]?.unit).toBe('degrees');
	});

	it('命名位姿来自上游 robot_config', () => {
		expect(catalog.namedPoses).toEqual(['home', 'observe_table', 'zero']);
	});

	it('命名位姿还带上了**落在哪个坐标上**，数字与上游 YAML 逐字相同', () => {
		// 名字列表只说得出「有个叫 observe_table 的位姿」。教学要的是那条调用落到哪儿，
		// 所以坐标必须一起导进来——而且是**照抄**：0.02160863957360322 不许被四舍五入成 0.0216。
		expect(catalog.namedPoseTargets?.map((target) => target.name)).toEqual(catalog.namedPoses);
		expect(catalog.namedPoseTargets?.find((target) => target.name === 'observe_table')).toEqual({
			name: 'observe_table',
			position: { x: 0.02160863957360322, y: -0.1310933191355222, z: 0.33769602460194537 },
			orientation: {
				x: -0.35328551634048977,
				y: -0.32020226597268203,
				z: -0.5842845082802226,
				w: 0.6567126207053827,
			},
		});
		// 上游这个文件里没有给位姿声明参考系或单位，所以**不写**——「base 系」「米」都不许编。
		expect(JSON.stringify(catalog.namedPoseTargets)).not.toContain('frame');
	});

	it('执行量（一步多远、方向映射、夹爪开合位）来自 embodied.execution，一个默认值都没补', () => {
		expect(catalog.execution).toEqual({
			relativeMotionStepM: 0.03,
			relativeMotionReferenceFrame: 'base',
			relativeMotionDirectionMapping: {
				forward: [0, -1, 0],
				backward: [0, 1, 0],
				left: [1, 0, 0],
				right: [-1, 0, 0],
				up: [0, 0, 1],
				down: [0, 0, -1],
			},
			// 注意这里是 0.15（这台设备的 YAML 写着 0.15），不是抓取那台的 0.0——
			// 两台配置各有一份副本，抄错一边屏幕上就会多一个假数字。
			gripperOpenPosition: 1,
			gripperClosedPosition: 0.15,
		});
	});

	it('轨迹模板的展开规则照上游代码抄：字段名、缺省、两种规则的区别', () => {
		const rules = new Map(catalog.trajectoryTemplates?.map((rule) => [rule.templateType, rule]));
		// wave_dance_v1 末尾补静止拍（上游 `zero_hold_count`），single_joint_wave_v1 没有这个字段。
		expect(rules.get('wave_dance_v1')).toEqual({
			templateType: 'wave_dance_v1',
			rule: 'cycle_repeat_hold',
			cycleField: 'active_waypoint_count',
			repeatField: 'repeat_count',
			repeatDefault: 1,
			holdField: 'zero_hold_count',
			holdDefault: 0,
			durationField: 'waypoint_duration_sec',
			durationDefaultSec: 0.08,
		});
		expect(rules.get('single_joint_wave_v1')).toEqual({
			templateType: 'single_joint_wave_v1',
			rule: 'cycle_repeat',
			cycleField: 'active_waypoint_count',
			// 上游这个生成器给了缺省 16；wave_dance_v1 给的是 0（等于「必须给」），所以上面没有 cycleDefault。
			cycleDefault: 16,
			repeatField: 'repeat_count',
			repeatDefault: 1,
			durationField: 'waypoint_duration_sec',
			durationDefaultSec: 0.08,
		});
	});

	it('原语参数的单位与范围是上游写的那些，没有的不编', () => {
		// `motion_distance` 这条字段名在上游两处含义不同：位移是 meters，旋转是 degrees。
		// 单位从模板的 `capability.parameters` 里读，`exclusiveMinimum` 是 `gateway_policy.py` 真在查的那条。
		const parameters = (primitiveRef: string) =>
			catalog.primitives.find((primitive) => primitive.primitiveRef === primitiveRef)?.parameters ?? [];
		expect(parameters('move_relative_ee')).toEqual([
			{ name: 'motion_direction', label: '移动方向', type: 'string' },
			{ name: 'motion_distance', label: '移动距离（米）', unit: 'meters', exclusiveMinimum: 0, type: 'number' },
		]);
		expect(parameters('rotate_gripper_cw')).toEqual([
			{ name: 'motion_distance', label: '旋转角度（度）', unit: 'degrees', exclusiveMinimum: 0, type: 'number' },
		]);
		// `duration_sec` 的「秒」只写在字段名里，上游没有声明 `unit` —— 所以它这里什么都不带。
		expect(parameters('move_to_joint_positions')).toEqual([
			{ name: 'joint_positions', label: '关节目标位置', type: 'json' },
			{ name: 'duration_sec', label: '到位时间（秒）', type: 'number' },
		]);
	});

	it('每条登记了落点的原语，说的那个实参真的是它自己的参数', () => {
		// 设备事实里的 `poseNameArgument: 'pose_name'` 要是写成一个不存在的参数名，
		// 渲染层查不到就什么都不写——那是**静默**失效。这条把它变成当场红。
		let registered = 0;
		for (const primitive of catalog.primitives) {
			const facts = primitive.deviceFacts;
			if (facts === undefined) continue;
			registered += 1;
			const declared = new Set(primitive.parameters.map((parameter) => parameter.name));
			for (const argument of [facts.poseNameArgument, facts.directionArgument, facts.trajectoryArgument]) {
				if (argument === undefined) continue;
				expect(declared.has(argument), `${primitive.primitiveRef} 的 ${argument}`).toBe(true);
			}
		}
		// 五条：move_to_named_pose / move_relative_ee / move_through_joint_positions / open_gripper / close_gripper。
		expect(registered).toBe(5);
		// 没登记的原语就是没登记：`move_to_pose` 的目标位姿是任务直接给的，不落在任何设备表上。
		expect(catalog.primitives.find((primitive) => primitive.primitiveRef === 'move_to_pose')?.deviceFacts).toBeUndefined();
	});

	it('夹爪归一化照上游 resolver 的行为展开在最前面', () => {
		// 上游 `initial_gripper_state: closed` 的技能，展开时会在序列最前面插一条 `close_gripper`。
		for (const capabilityRef of ['wave_hello', 'dance_basic', 'celebrate', 'act_cute']) {
			expect(implementationOf(capabilityRef)[0], capabilityRef).toEqual({
				kind: 'call',
				primitiveRef: 'close_gripper',
				arguments: {},
			});
		}
		// 纯夹爪技能不带这个字段，也就不该多出一条。
		expect(implementationOf('open_gripper_skill')).toEqual([
			{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} },
		]);
	});

	it('`*_from_request` 落成参数引用，写死的值落成字面量', () => {
		// `move_relative_ee` 的方向与距离来自任务请求——这正是「同一份实现被不同参数复用」那条链。
		expect(implementationOf('move_relative_ee')).toEqual([
			{
				kind: 'call',
				primitiveRef: 'move_relative_ee',
				arguments: {
					motion_direction: { kind: 'param', name: 'motion_direction' },
					motion_distance: { kind: 'param', name: 'motion_distance' },
				},
			},
		]);
		// `celebrate` 写死了方向与距离，落成字面量。
		expect(implementationOf('celebrate')[2]).toEqual({
			kind: 'call',
			primitiveRef: 'move_relative_ee',
			arguments: {
				motion_direction: { kind: 'literal', value: 'up' },
				motion_distance: { kind: 'literal', value: 0.04 },
			},
		});
	});

	it('关节位置映射与轨迹模板原样带过来（结构化载荷没被吃掉）', () => {
		const jointCall = implementationOf('wave_hello')[1];
		expect(jointCall?.kind).toBe('call');
		if (jointCall?.kind !== 'call') throw new Error('预期是一次调用');
		expect(jointCall.arguments['joint_positions']).toEqual({
			kind: 'literal',
			value: { '1': 0.02, '2': 0.54, '3': -0.82, '4': -0.18, '5': 0.02 },
		});

		const trajectoryCall = implementationOf('wave_hello')[2];
		if (trajectoryCall?.kind !== 'call') throw new Error('预期是一次调用');
		expect(literalValueOf(trajectoryCall.arguments['trajectory_template'])).toMatchObject({
			type: 'single_joint_wave_v1',
			joint: '5',
			amplitude: 0.35,
		});
	});
});

describe('RoboFrame 抓取目录的实情（第二台设备，实现在执行侧的那种技能）', () => {
	const catalog = ROBOFRAME_GRASP_CATALOG;
	const capabilityOf = (capabilityRef: string): CapabilitySpec => {
		const capability = catalog.capabilities.find((item) => item.capabilityRef === capabilityRef);
		if (capability === undefined) throw new Error(`目录里没有 ${capabilityRef}`);
		return capability;
	};

	it('带出了它在上游的出处，且与单臂目录同源同版本', () => {
		expect(ROBOFRAME_GRASP_PROVENANCE.upstream).toContain('IB_Robot');
		expect(ROBOFRAME_GRASP_PROVENANCE.branch).toBe('RoboFrame');
		expect(ROBOFRAME_GRASP_PROVENANCE.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(ROBOFRAME_GRASP_PROVENANCE.robotConfig).toContain('so101_handeye_realsense_grasp.yaml');
		// 两份配置转自同一次上游检出——commit 必须逐字相同，否则两份目录说的不是同一个版本的东西。
		expect(ROBOFRAME_GRASP_PROVENANCE.commit).toBe(ROBOFRAME_SO101_PROVENANCE.commit);
	});

	it('上游那份抓取配置的七个技能都在', () => {
		const refs = catalog.capabilities.map((capability) => capability.capabilityRef);
		for (const skill of [
			'inspect_scene',
			'recover_safe_pose',
			'recover_zero_pose',
			'move_relative_ee',
			'open_gripper_skill',
			'close_gripper_skill',
			'pick_object',
		]) {
			expect(refs, `missing skill: ${skill}`).toContain(skill);
		}
	});

	it('pick_object 的实现是**一条委托**：实现在执行侧，模板里只有接口名', () => {
		// 上游这份技能的 `primitive_sequence` 是空的——它把能力委托给 `/manipulation/execute_pick`，
		// GraspGen 在运行时才生成 6-DOF 候选。所以这里断言的不是"几条步骤"，而是**只有一条委托**：
		// 多一条原语调用就说明我们替上游编了步骤，少一条就说明这个技能又变成"装不下"了。
		expect(capabilityOf('pick_object').implementation).toEqual([
			{
				kind: 'delegate',
				interfaceRef: '/manipulation/execute_pick',
				arguments: { target_name: { kind: 'param', name: 'target_name' } },
			},
		]);
	});

	it('target_name 是必填的 string，取值来自这个技能自己的参数', () => {
		const capability = capabilityOf('pick_object');
		expect(capability.parameters).toEqual([
			// `label` 是上游 JSON Schema 里没有 `description` 时的兜底（用参数名），不是我们编的中文。
			{ name: 'target_name', label: 'target_name', type: 'string', required: true },
		]);
		expect(capability.label).toBe('抓取物体'); // 中文别名当了 label
	});

	it('委托的接口名**不是**原语：白名单还是 skill_library 的那十个', () => {
		expect(catalog.primitives.map((primitive) => primitive.primitiveRef)).toEqual([
			'move_to_named_pose',
			'move_to_pose',
			'move_to_configuration',
			'move_relative_ee',
			'move_to_joint_positions',
			'move_through_joint_positions',
			'open_gripper',
			'close_gripper',
			'rotate_gripper_cw',
			'rotate_gripper_ccw',
		]);
		expect(catalog.primitives.some((primitive) => primitive.primitiveRef === '/manipulation/execute_pick')).toBe(
			false,
		);
	});

	it('有实现的技能照旧是原语展开，没被误判成委托', () => {
		expect(capabilityOf('recover_zero_pose').implementation).toEqual([
			{
				kind: 'call',
				primitiveRef: 'move_to_named_pose',
				arguments: { pose_name: { kind: 'literal', value: 'zero' } },
			},
		]);
		expect(capabilityOf('move_relative_ee').implementation).toEqual([
			{
				kind: 'call',
				primitiveRef: 'move_relative_ee',
				arguments: {
					motion_direction: { kind: 'param', name: 'motion_direction' },
					motion_distance: { kind: 'param', name: 'motion_distance' },
				},
			},
		]);
	});
});

/**
 * 两份产物的**字节**指纹。
 *
 * 为什么钉这个：导入第二台设备最容易出的错不是"新目录不对"，而是**顺手把第一份改坏了**
 * （多改一个字段、换个遍历顺序、`.map` 时顺手补个默认值）。这一条就是那道栏杆——
 * 单臂目录的字节只应该因为"上游换了 commit、或有意的改动"而变化，那时把指纹一起更新，
 * 顺带被逼着看一眼 diff。目录本身对不对由上面那些断言管，这里只管"有没有被动过"。
 *
 * 2026 设备事实那一层进来时两份指纹都换过一次。那次 diff 是**纯新增**：
 * 单臂 +129 行、抓取 +123 行，`-` 行 0 行——新键一律插在别的键**前面**，
 * 所以连一个逗号都没碰到已有字节（判据写在 `import.mjs` 的 `parameterOf` 上）。
 *
 * 「执行侧接口名 + 原语的运行时能力」那两层进来时又换过一次，同样是纯新增：
 * 单臂 +100 行、抓取 +101 行，`-` 行 0 行（`interfaces` 插在 `primitives` 前、
 * `runtimeCapabilities` 插在 `parameters` 前）。
 */
/**
 * 2026 新补的两层：执行侧接口名（配置级）与原语的运行时能力（每条一份）。
 *
 * 这两层的判据只有一条：**逐字来自上游**。所以这里断言的是「值等于上游写的那个」，
 * 而不是「有个字段」——「有个字段」那种断言在编一个默认值顶上去时照样绿。
 */
describe('执行侧接口名与运行时能力（新补的两层）', () => {
	const RUNTIME_CAPABILITY_NAMES = ['validate_skill', 'task_executor', 'arm_trajectory', 'fresh_ee_pose'];

	it('接口名表逐字来自上游 YAML，两台设备的差别就是上游的差别', () => {
		expect(ROBOFRAME_SO101_CATALOG.interfaces).toEqual({
			task_command_topic: '/embodied/task_command',
			status_topic: '/embodied/task_status',
			skill_action_name: '/embodied/execute_skill',
			primitive_action_name: '/embodied/execute_primitive',
			validate_skill_service: '/embodied/validate_skill',
			task_executor_action_name: '/task_executor/execute_task_plan',
		});
		// 抓取那份多一条：move_configuration_service 只在它上游的 embodied.execution 里写着。
		expect(ROBOFRAME_GRASP_CATALOG.interfaces).toEqual({
			...ROBOFRAME_SO101_CATALOG.interfaces,
			move_configuration_service: '/moveit_gateway/move_to_configuration',
		});
	});

	it('两个 action 是分开的：技能走 execute_skill、原语走 execute_primitive', () => {
		expect(ROBOFRAME_SO101_CATALOG.interfaces?.skill_action_name).toBe('/embodied/execute_skill');
		expect(ROBOFRAME_SO101_CATALOG.interfaces?.primitive_action_name).toBe('/embodied/execute_primitive');
	});

	it('运行时能力：能力名与「缺了怎么说」都是上游 gateway_policy 的原文', () => {
		const open = findPrimitive(ROBOFRAME_SO101_CATALOG, 'open_gripper');
		expect(open?.runtimeCapabilities).toEqual([
			{ name: 'validate_skill', unavailableMessage: 'validate skill service unavailable' },
			{ name: 'task_executor', unavailableMessage: 'task executor action unavailable' },
		]);
		// 相对运动要多一条末端位姿的新鲜度——这正是上游那张表存在的理由。
		const relative = findPrimitive(ROBOFRAME_SO101_CATALOG, 'move_relative_ee');
		expect(relative?.runtimeCapabilities?.map((item) => item.name)).toEqual([
			'validate_skill',
			'task_executor',
			'fresh_ee_pose',
		]);
	});

	it('上游没登记的两条原语：字段整个不出现（空数组与「没说」不是一回事）', () => {
		for (const catalog of [ROBOFRAME_SO101_CATALOG, ROBOFRAME_GRASP_CATALOG]) {
			for (const primitiveRef of ['move_to_pose', 'move_to_configuration']) {
				const primitive = findPrimitive(catalog, primitiveRef);
				expect(primitive).toBeDefined();
				expect('runtimeCapabilities' in (primitive ?? {})).toBe(false);
			}
		}
	});

	it('能力名不许是编的：每一个都在上游那四个字段里', () => {
		for (const catalog of [ROBOFRAME_SO101_CATALOG, ROBOFRAME_GRASP_CATALOG]) {
			for (const primitive of catalog.primitives) {
				for (const capability of primitive.runtimeCapabilities ?? []) {
					expect(RUNTIME_CAPABILITY_NAMES).toContain(capability.name);
				}
			}
		}
	});

	it('两台设备里同一批原语的运行时能力必须一模一样（同一份 gateway_policy）', () => {
		const byRef = (catalog: CapabilityCatalog): Map<string, unknown> =>
			new Map(catalog.primitives.map((primitive) => [primitive.primitiveRef, primitive.runtimeCapabilities]));
		const single = byRef(ROBOFRAME_SO101_CATALOG);
		for (const [ref, capabilities] of byRef(ROBOFRAME_GRASP_CATALOG)) {
			expect(capabilities).toEqual(single.get(ref));
		}
	});
});

describe('两份目录各自的产物稳定', () => {
	const DIGESTS: Record<string, string> = {
		'so101_single_arm.catalog.json': 'cae68d151f27a3768e3219b1928cadf748d5f483b7dac8eed8b7c312da61cafd',
		'so101_handeye_realsense_grasp.catalog.json': '5e146f4d5a55f0468f147e9b8eb4de51a5e56fca1553b08751fd370082ca13e5',
	};

	it('每份产物的字节没动过', () => {
		for (const [file, digest] of Object.entries(DIGESTS)) {
			const text = readFileSync(new URL(`../src/roboframe/${file}`, import.meta.url), 'utf8');
			expect(sha256Hex(text), `${file} 的字节变了——是有意的吗？`).toBe(digest);
		}
	});

	it('revisionRef 钉在上游 commit 上，两份各自不同', () => {
		expect(ROBOFRAME_SO101_CATALOG.revisionRef).toBe('roboframe-so101_single_arm-8f364c3f');
		expect(ROBOFRAME_GRASP_CATALOG.revisionRef).toBe('roboframe-so101_handeye_realsense_grasp-8f364c3f');
	});

	it('抓取那份没有顶掉单臂那份（两份目录各自是完整的）', () => {
		expect(ROBOFRAME_SO101_CATALOG.catalogRef).not.toBe(ROBOFRAME_GRASP_CATALOG.catalogRef);
		expect(ROBOFRAME_SO101_CATALOG.capabilities).toHaveLength(16);
		expect(ROBOFRAME_GRASP_CATALOG.capabilities).toHaveLength(7);
	});
});

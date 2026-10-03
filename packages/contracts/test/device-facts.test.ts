/**
 * 设备事实：**形状**在 schema 里、**读法**在这几个函数里，两样都在这条测试上钉住。
 *
 * 为什么单开一份：这一层不是「多几个可选字段」，它换了一个前提——目录里原来的东西都是
 * 「这台设备会什么」，这一层是「那些动作落到哪些真实数值上」。数值是给模型当参考材料的
 * （机器会什么、命名位姿的真实坐标、一步走多远），所以**读不出来就等于没有**：
 * 一个查不到的名字必须给 `undefined`，绝不能返回一个零点顶上——模型照着零点写，
 * 屏幕上就会出现一个上游从没写过的坐标。
 *
 * 这里用的是手写的夹具目录（形状固定、跑得快）；真实目录那一侧的读数证据在
 * `packages/capabilities/test/device-facts.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
	capabilityCatalogSchema,
	describeDeviceFacts,
	expandTrajectoryTemplateOf,
	findNamedPoseTarget,
	findTrajectoryTemplateRule,
	gripperPositionOf,
	relativeMotionOf,
	type CapabilityCatalog,
	type JsonValue,
} from '../src/index';

const RAW_CATALOG = {
	catalogRef: 'fixture_arm',
	displayName: '夹具臂',
	revisionRef: 'fixture-arm-v1',
	namedPoses: ['home', 'observe_table'],
	namedPoseTargets: [
		{ name: 'home', position: { x: 0.1, y: 0.2, z: 0.3 } },
		{
			name: 'observe_table',
			position: { x: 0.02160863957360322, y: -0.1310933191355222, z: 0.33769602460194537 },
			orientation: { x: -0.35328551634048977, y: -0.32020226597268203, z: -0.5842845082802226, w: 0.6567126207053827 },
		},
	],
	execution: {
		relativeMotionStepM: 0.03,
		relativeMotionReferenceFrame: 'base',
		relativeMotionDirectionMapping: { forward: [0, -1, 0], up: [0, 0, 1] },
		gripperOpenPosition: 1,
		gripperClosedPosition: 0.15,
	},
	trajectoryTemplates: [
		{
			templateType: 'wave_dance_v1',
			rule: 'cycle_repeat_hold',
			cycleField: 'active_waypoint_count',
			repeatField: 'repeat_count',
			repeatDefault: 1,
			holdField: 'zero_hold_count',
			holdDefault: 0,
			durationField: 'waypoint_duration_sec',
			durationDefaultSec: 0.08,
		},
		{
			templateType: 'single_joint_wave_v1',
			rule: 'cycle_repeat',
			cycleField: 'active_waypoint_count',
			cycleDefault: 16,
			repeatField: 'repeat_count',
			repeatDefault: 1,
			durationField: 'waypoint_duration_sec',
			durationDefaultSec: 0.08,
		},
	],
	primitives: [
		{ primitiveRef: 'move_to_named_pose', label: '移动到命名位姿', parameters: [{ name: 'pose_name', label: '命名位姿', type: 'pose' }], deviceFacts: { poseNameArgument: 'pose_name' } },
		{
			primitiveRef: 'move_relative_ee',
			label: '末端相对移动',
			parameters: [{ name: 'motion_direction', label: '移动方向', type: 'string' }],
			deviceFacts: { directionArgument: 'motion_direction' },
		},
		{ primitiveRef: 'open_gripper', label: '张开夹爪', parameters: [], deviceFacts: { gripperPosition: 'open' } },
		{
			primitiveRef: 'move_through_joint_positions',
			label: '走关节轨迹',
			parameters: [{ name: 'trajectory_template', label: '轨迹模板', type: 'json' }],
			deviceFacts: { trajectoryArgument: 'trajectory_template' },
		},
		{ primitiveRef: 'wait', label: '等待', parameters: [{ name: 'seconds', label: '时长', type: 'number' }] },
	],
	capabilities: [
		{
			capabilityRef: 'inspect_scene',
			label: '观察桌面',
			kind: 'skill',
			parameters: [],
			implementation: [
				{ kind: 'call', primitiveRef: 'move_to_named_pose', arguments: { pose_name: { kind: 'literal', value: 'observe_table' } } },
			],
		},
	],
};

const parse = (catalog: unknown) => capabilityCatalogSchema.safeParse(catalog);
const CATALOG: CapabilityCatalog = capabilityCatalogSchema.parse(RAW_CATALOG);

const primitiveOf = (primitiveRef: string) => {
	const found = CATALOG.primitives.find((primitive) => primitive.primitiveRef === primitiveRef);
	if (found === undefined) throw new Error(`夹具里没有 ${primitiveRef}`);
	return found;
};

describe('设备事实进得了契约', () => {
	it('四类事实原样过 schema，且回传不添不减', () => {
		const parsed = parse(RAW_CATALOG);
		if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 3)));
		expect(parsed.data.namedPoseTargets).toEqual(RAW_CATALOG.namedPoseTargets);
		expect(parsed.data.execution).toEqual(RAW_CATALOG.execution);
		expect(parsed.data.trajectoryTemplates).toEqual(RAW_CATALOG.trajectoryTemplates);
		expect(primitiveOf('move_to_named_pose').deviceFacts).toEqual({ poseNameArgument: 'pose_name' });
	});

	it('没有这一层的目录照旧解析得动（四个字段全是可选）', () => {
		const { namedPoseTargets, execution, trajectoryTemplates, ...rest } = RAW_CATALOG;
		expect([namedPoseTargets, execution, trajectoryTemplates].every((part) => part !== undefined)).toBe(true);
		const bare = { ...rest, primitives: rest.primitives.map(({ deviceFacts, ...primitive }) => primitive) };
		expect(parse(bare).success).toBe(true);
	});

	it('位姿缺一个分量被拒：不许补 0，也不许少一个轴', () => {
		const broken = {
			...RAW_CATALOG,
			namedPoseTargets: [{ name: 'home', position: { x: 0.1, y: 0.2 } }],
		};
		expect(parse(broken).success).toBe(false);
	});

	it('位姿的 position 与 orientation 都缺被拒：这条事实要说出点什么才值得写进目录', () => {
		expect(parse({ ...RAW_CATALOG, namedPoseTargets: [{ name: 'home' }] }).success).toBe(false);
	});

	it('轨迹规则的 rule 与 holdField 必须一致（两种规则的区别就在这一个字段上）', () => {
		const [wave] = RAW_CATALOG.trajectoryTemplates;
		if (wave === undefined) throw new Error('夹具少了 wave_dance_v1');
		// 声称有静止拍、却没说是哪个字段。
		const { holdField, ...withoutHoldField } = wave;
		expect(holdField).toBe('zero_hold_count');
		expect(parse({ ...RAW_CATALOG, trajectoryTemplates: [withoutHoldField] }).success).toBe(false);
		// 反过来：声明是 cycle_repeat，却带着 holdField。
		expect(
			parse({ ...RAW_CATALOG, trajectoryTemplates: [{ ...wave, rule: 'cycle_repeat' }] }).success,
		).toBe(false);
	});

	it('形状不许自己长：多一个键就被拒（strict）', () => {
		expect(parse({ ...RAW_CATALOG, execution: { ...RAW_CATALOG.execution, torqueLimit: 3 } }).success).toBe(false);
		expect(parse({ ...RAW_CATALOG, namedPoseTargets: [{ name: 'home', frame: 'base' }] }).success).toBe(false);
		expect(
			parse({
				...RAW_CATALOG,
				primitives: [
					{ primitiveRef: 'open_gripper', label: '张开夹爪', parameters: [], deviceFacts: { gripperPosition: 'ajar' } },
				],
			}).success,
		).toBe(false);
	});

	it('方向向量的三元组长度被钉死（两个数的「向量」不是向量）', () => {
		const broken = { ...RAW_CATALOG, execution: { ...RAW_CATALOG.execution, relativeMotionDirectionMapping: { forward: [0, -1] } } };
		expect(parse(broken).success).toBe(false);
	});
});

describe('按名字读：读不到就给 undefined，不编', () => {
	it('命名位姿：查得到就给出位置与姿态，查不到就是 undefined', () => {
		expect(findNamedPoseTarget(CATALOG, 'observe_table')).toEqual({
			name: 'observe_table',
			position: { x: 0.02160863957360322, y: -0.1310933191355222, z: 0.33769602460194537 },
			orientation: {
				x: -0.35328551634048977,
				y: -0.32020226597268203,
				z: -0.5842845082802226,
				w: 0.6567126207053827,
			},
		});
		expect(findNamedPoseTarget(CATALOG, 'nowhere')).toBeUndefined();
		// 名字对但只有半截（夹具里的 home 没写姿态）：缺的那半就是缺的，不补一个单位四元数。
		expect(findNamedPoseTarget(CATALOG, 'home')?.orientation).toBeUndefined();
	});

	it('相对运动：一次给全方向、参考系、向量、步长', () => {
		expect(relativeMotionOf(CATALOG, 'forward')).toEqual({
			direction: 'forward',
			referenceFrame: 'base',
			vector: [0, -1, 0],
			stepM: 0.03,
		});
		// 方向名不在映射里 → undefined（**不**拿上游 resolver 里那份兜底映射顶上）。
		expect(relativeMotionOf(CATALOG, 'sideways')).toBeUndefined();
	});

	it('夹爪到位值：张开位与闭合位分开问，没导就是 undefined', () => {
		expect(gripperPositionOf(CATALOG, 'open')).toBe(1);
		expect(gripperPositionOf(CATALOG, 'closed')).toBe(0.15);
		const withoutExecution = { ...CATALOG } as CapabilityCatalog;
		delete (withoutExecution as { execution?: unknown }).execution;
		expect(gripperPositionOf(withoutExecution, 'open')).toBeUndefined();
		expect(relativeMotionOf(withoutExecution, 'forward')).toBeUndefined();
	});

	it('轨迹模板规则：认得出给规则，认不出给 undefined', () => {
		expect(findTrajectoryTemplateRule(CATALOG, 'single_joint_wave_v1')?.cycleDefault).toBe(16);
		expect(findTrajectoryTemplateRule(CATALOG, 'salsa_v9')).toBeUndefined();
		expect(findTrajectoryTemplateRule(CATALOG, 42)).toBeUndefined();
	});
});

describe('轨迹模板展开成多少拍、多长时间', () => {
	it('cycle_repeat：拍数 = 循环 × 重复，缺省那两个字段照上游取', () => {
		expect(expandTrajectoryTemplateOf(CATALOG, { type: 'single_joint_wave_v1', repeat_count: 3, waypoint_duration_sec: 0.05 })).toEqual({
			templateType: 'single_joint_wave_v1',
			rule: 'cycle_repeat',
			cycle: 16, // 上游 generate_single_joint_wave_v1 的缺省
			repeat: 3,
			hold: 0,
			waypointCount: 48,
			waypointDurationSec: 0.05,
			totalSec: 2.4, // 浮点噪声（2.4000000000000004）不许上屏
		});
	});

	it('cycle_repeat_hold：末尾的静止拍是**加法**，不是又一次重复', () => {
		expect(
			expandTrajectoryTemplateOf(CATALOG, { type: 'wave_dance_v1', active_waypoint_count: 120, repeat_count: 3, zero_hold_count: 4, waypoint_duration_sec: 0.05 }),
		).toEqual({
			templateType: 'wave_dance_v1',
			rule: 'cycle_repeat_hold',
			cycle: 120,
			repeat: 3,
			hold: 4,
			waypointCount: 364,
			waypointDurationSec: 0.05,
			totalSec: 18.2,
		});
	});

	it('缺了必给的字段就是展开不出来（上游对非正数直接抛错，这里同样不认）', () => {
		// wave_dance_v1 的 active_waypoint_count 上游缺省是 0，等于「必须给」。
		expect(expandTrajectoryTemplateOf(CATALOG, { type: 'wave_dance_v1', repeat_count: 3 })).toBeUndefined();
		expect(expandTrajectoryTemplateOf(CATALOG, { type: 'wave_dance_v1', active_waypoint_count: 0 })).toBeUndefined();
		expect(expandTrajectoryTemplateOf(CATALOG, { type: 'wave_dance_v1', active_waypoint_count: 16, repeat_count: 0 })).toBeUndefined();
	});

	it('认不出的模板类型什么都不说，也不猜一个', () => {
		expect(expandTrajectoryTemplateOf(CATALOG, { type: 'unsupported', active_waypoint_count: 16 })).toBeUndefined();
		expect(expandTrajectoryTemplateOf(CATALOG, { active_waypoint_count: 16 })).toBeUndefined();
		expect(expandTrajectoryTemplateOf(CATALOG, 'wave_dance_v1')).toBeUndefined();
		expect(expandTrajectoryTemplateOf(CATALOG, undefined)).toBeUndefined();
	});
});

describe('把一次调用说成人话（给提示词用的那几句）', () => {
	const values = (poseName: string): Readonly<Record<string, JsonValue | undefined>> => ({ pose_name: poseName });

	it('命名位姿那条：名字 → named_poses.<名字>，再跟坐标', () => {
		const lines = describeDeviceFacts(CATALOG, primitiveOf('move_to_named_pose'), values('observe_table'));
		expect(lines).toEqual([
			'pose_name="observe_table" → named_poses.observe_table',
			'  位置 x=0.02160863957360322 y=-0.1310933191355222 z=0.33769602460194537',
			'  姿态 四元数 x=-0.35328551634048977 y=-0.32020226597268203 z=-0.5842845082802226 w=0.6567126207053827',
		]);
	});

	it('夹爪那条：说清这条原语落到哪个到位值上', () => {
		expect(describeDeviceFacts(CATALOG, primitiveOf('open_gripper'), {})).toEqual([
			'张开到位 1.0；闭合位 0.15（execution.gripper_open_position / _closed_position）',
		]);
	});

	it('查不到就一行都不写——名字不认识、原语没登记、实参没给值', () => {
		expect(describeDeviceFacts(CATALOG, primitiveOf('move_to_named_pose'), values('nowhere'))).toEqual([]);
		expect(describeDeviceFacts(CATALOG, primitiveOf('move_to_named_pose'), {})).toEqual([]);
		// 没登记 deviceFacts 的原语：一个字都不说，也不去猜它落在哪。
		expect(describeDeviceFacts(CATALOG, primitiveOf('wait'), { seconds: 1 })).toEqual([]);
	});
});

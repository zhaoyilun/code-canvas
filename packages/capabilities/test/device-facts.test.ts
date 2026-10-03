/**
 * **从真目录里读设备事实**：这几样东西读得出来，模型才有参考材料。
 *
 * 这一份是「能读出来」那条判据的现场证据——它对着上游真数据（`ROBOFRAME_*_CATALOG`）
 * 走一遍读的入口，并把读到的原样打印出来。打印是有意的：这几段输出就是交给下一次模型调用的
 * 参考材料长什么样（命名位姿的真实坐标、一步多远、夹爪张到几），照着屏幕上的字核对上游 YAML 即可。
 *
 * 四类事实各读一遍：
 * 1. `named_poses.observe_table` 落在哪个坐标（位置 + 四元数）；
 * 2. `forward` 在 base 系里是哪个向量、设备默认一步多远；
 * 3. 张开/闭合夹爪各到几；
 * 4. 一个轨迹模板展开成多少拍、多长时间。
 *
 * 而且两台设备**读出来必须不同**：抓取那份的 `gripper_closed_position` 是 0.0，
 * 单臂那份是 0.15（YAML 里就写着 0.15）。抄错一边，模型就会照着假数字写教学规格——
 * 所以这条差异也钉在这里。
 */
import { describe, expect, it } from 'vitest';
import { ROBOFRAME_GRASP_CATALOG, ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import {
	describeDeviceFacts,
	expandTrajectoryTemplateOf,
	findNamedPoseTarget,
	findTrajectoryTemplateRule,
	gripperPositionOf,
	relativeMotionOf,
	type JsonValue,
} from '@codecanvas/contracts';

/** 上游 `so101_single_arm.yaml` 里 `wave_hello` 第二步的那个模板（原样抄下来当输入）。 */
const WAVE_HELLO_TEMPLATE = {
	type: 'single_joint_wave_v1',
	waypoint_duration_sec: 0.05,
	active_waypoint_count: 16,
	repeat_count: 3,
};

describe('从单臂目录里读设备事实（这几段输出就是交给模型的参考材料）', () => {
	it('① 命名位姿：observe_table 落在哪个坐标', () => {
		const target = findNamedPoseTarget(ROBOFRAME_SO101_CATALOG, 'observe_table');
		console.log('[① 命名位姿] observe_table =', JSON.stringify(target, null, 1));

		expect(target).toEqual({
			name: 'observe_table',
			position: { x: 0.02160863957360322, y: -0.1310933191355222, z: 0.33769602460194537 },
			orientation: {
				x: -0.35328551634048977,
				y: -0.32020226597268203,
				z: -0.5842845082802226,
				w: 0.6567126207053827,
			},
		});
		// 上游这份 YAML 没给位姿声明参考系，也没声明单位——所以读出来也不带这两样。
		expect(Object.keys(target ?? {})).toEqual(['name', 'position', 'orientation']);
		// 查不到的名字就是 undefined：不拿别的位姿顶上，也不给零点。
		expect(findNamedPoseTarget(ROBOFRAME_SO101_CATALOG, 'table')).toBeUndefined();
	});

	it('② 相对运动：forward 在 base 系里是哪个向量、一步多远', () => {
		const motion = relativeMotionOf(ROBOFRAME_SO101_CATALOG, 'forward');
		console.log('[② 相对运动] forward =', JSON.stringify(motion));

		expect(motion).toEqual({ direction: 'forward', referenceFrame: 'base', vector: [0, -1, 0], stepM: 0.03 });
		// 六个方向都在，且都是上游写的那三个数。
		expect(['up', 'down', 'left', 'right'].map((name) => relativeMotionOf(ROBOFRAME_SO101_CATALOG, name)?.vector)).toEqual([
			[0, 0, 1],
			[0, 0, -1],
			[1, 0, 0],
			[-1, 0, 0],
		]);
		expect(relativeMotionOf(ROBOFRAME_SO101_CATALOG, 'sideways')).toBeUndefined();
	});

	it('③ 夹爪到位值：两台设备读出来不一样，各是各的 YAML', () => {
		const single = {
			open: gripperPositionOf(ROBOFRAME_SO101_CATALOG, 'open'),
			closed: gripperPositionOf(ROBOFRAME_SO101_CATALOG, 'closed'),
		};
		const grasp = {
			open: gripperPositionOf(ROBOFRAME_GRASP_CATALOG, 'open'),
			closed: gripperPositionOf(ROBOFRAME_GRASP_CATALOG, 'closed'),
		};
		console.log('[③ 夹爪] so101_single_arm =', JSON.stringify(single), ' so101_handeye_realsense_grasp =', JSON.stringify(grasp));

		expect(single).toEqual({ open: 1, closed: 0.15 });
		expect(grasp).toEqual({ open: 1, closed: 0 });
		// 两份共用一个上游 commit，但数值不同——说明读的是**各自那份 YAML**，不是某一份被复用了。
		expect(single.closed).not.toBe(grasp.closed);
	});

	it('④ 轨迹模板：wave_hello 那个模板展开成 48 拍、共 2.4 秒', () => {
		const rule = findTrajectoryTemplateRule(ROBOFRAME_SO101_CATALOG, 'single_joint_wave_v1');
		const expansion = expandTrajectoryTemplateOf(ROBOFRAME_SO101_CATALOG, WAVE_HELLO_TEMPLATE);
		console.log('[④ 轨迹展开] rule =', JSON.stringify(rule), '\n           expansion =', JSON.stringify(expansion));

		expect(expansion).toEqual({
			templateType: 'single_joint_wave_v1',
			rule: 'cycle_repeat',
			cycle: 16,
			repeat: 3,
			hold: 0,
			waypointCount: 48,
			waypointDurationSec: 0.05,
			totalSec: 2.4,
		});
		// 认不出的模板类型读不出来——调用方什么都不说，不猜一个。
		expect(expandTrajectoryTemplateOf(ROBOFRAME_SO101_CATALOG, { type: 'salsa_v2' })).toBeUndefined();
	});
});

describe('把一条调用说成人话：这三句话就是「它落到哪儿」', () => {
	const valuesOf = (primitiveRef: string, arguments_: Readonly<Record<string, JsonValue | undefined>>) => {
		const primitive = ROBOFRAME_SO101_CATALOG.primitives.find((item) => item.primitiveRef === primitiveRef);
		if (primitive === undefined) throw new Error(`单臂目录里没有 ${primitiveRef}`);
		return describeDeviceFacts(ROBOFRAME_SO101_CATALOG, primitive, arguments_);
	};

	it('inspect_scene 的那一条原语：位姿名 → 坐标', () => {
		const lines = valuesOf('move_to_named_pose', { pose_name: 'observe_table' });
		console.log('[说话] move_to_named_pose:\n' + lines.map((line) => `  ${line}`).join('\n'));
		expect(lines[0]).toBe('pose_name="observe_table" → named_poses.observe_table');
		expect(lines).toHaveLength(3);
	});

	it('move_relative_ee 的那一条原语：方向 + 一步多远', () => {
		const lines = valuesOf('move_relative_ee', { motion_direction: 'forward' });
		console.log('[说话] move_relative_ee:\n' + lines.map((line) => `  ${line}`).join('\n'));
		expect(lines).toEqual([
			'forward 在 base 系是 (0.0, -1.0, 0.0)；设备默认一步 0.03 m（execution.relative_motion_direction_mapping / relative_motion_step_m）',
		]);
	});

	it('open_gripper 的那一条原语：张到几，以及另一个到位值', () => {
		const lines = valuesOf('open_gripper', {});
		console.log('[说话] open_gripper:\n' + lines.map((line) => `  ${line}`).join('\n'));
		expect(lines).toEqual(['张开到位 1.0；闭合位 0.15（execution.gripper_open_position / _closed_position）']);
	});

	it('move_through_joint_positions 的那一条原语：模板展开成多少拍', () => {
		const lines = valuesOf('move_through_joint_positions', { trajectory_template: WAVE_HELLO_TEMPLATE });
		console.log('[说话] move_through_joint_positions:\n' + lines.map((line) => `  ${line}`).join('\n'));
		expect(lines).toEqual(['模板 single_joint_wave_v1 展开成 16 × 3 = 48 拍，每拍 0.05 秒，共 2.4 秒']);
	});

	it('认不出的东西一句话都不说（celebrate 里那个 up 方向也确实读得到，但没有编的「意图」）', () => {
		// `celebrate` 里那条 `move_relative_ee(motion_direction="up")`：读得出方向与一步距离，
		// 读不出的（「抬起来打招呼」这类意图）**一个字都不写**。
		expect(valuesOf('move_relative_ee', { motion_direction: 'up' })).toEqual([
			'up 在 base 系是 (0.0, 0.0, 1.0)；设备默认一步 0.03 m（execution.relative_motion_direction_mapping / relative_motion_step_m）',
		]);
		expect(valuesOf('move_relative_ee', { motion_direction: 'louder' })).toEqual([]);
		expect(valuesOf('move_relative_ee', {})).toEqual([]);
	});
});

/**
 * 设备表的**顺序是一件事**，不是排版：第一条是打开页面时选中的那台。
 *
 * 这条测试存在的理由很具体：把"看不出动静"的设备放在默认位置，打开页面的人第一眼
 * 就以为这东西还没做完——而它其实能跑。所以默认那台必须是**能立刻演一遍**的那台。
 */
import { describe, expect, it } from 'vitest';
import { DEVICES, findDevice } from './devices';

describe('设备表', () => {
	it('默认（第一条）是能立刻演一遍的那台：虚拟设备', () => {
		const first = DEVICES[0];
		expect(first).toBeDefined();
		expect(first?.virtual).toBe(true);
		expect(first?.deviceRef).toBe('so101_sim');
	});

	it('真机在册、与虚拟设备共用同一份技能库（换的只是去处）', () => {
		const robot = findDevice('so101_robot');
		const sim = findDevice('so101_sim');
		expect(robot).not.toBeNull();
		expect(robot?.virtual).toBe(false);
		expect(robot?.catalog).toBe(sim?.catalog);
		expect(robot?.formatRef).toBe(sim?.formatRef);
	});

	it('每一台都有自己的目录与任务格式，ref 不重复', () => {
		const refs = DEVICES.map((device) => device.deviceRef);
		expect(new Set(refs).size).toBe(refs.length);
		for (const device of DEVICES) {
			expect(device.catalog.capabilities.length).toBeGreaterThan(0);
		}
	});

	it('两台机器各一对（虚拟 / 真机），各跑各的目录——两份目录不是同一份', () => {
		const pairs: readonly (readonly [string, string])[] = [
			['so101_sim', 'so101_robot'],
			['so101_grasp_sim', 'so101_grasp_robot'],
		];
		for (const [simRef, robotRef] of pairs) {
			const sim = findDevice(simRef);
			const robot = findDevice(robotRef);
			expect(sim, simRef).not.toBeNull();
			expect(robot, robotRef).not.toBeNull();
			expect(sim?.virtual).toBe(true);
			expect(robot?.virtual).toBe(false);
			// 同一对共用一份目录（换的只是去处），跨对**必须**不同。
			expect(robot?.catalog).toBe(sim?.catalog);
		}
		expect(findDevice('so101_sim')?.catalog).not.toBe(findDevice('so101_grasp_sim')?.catalog);
	});

	it('抓取那台带得动委托型技能：目录里那条 `pick_object` 的实现在执行侧', () => {
		const grasp = findDevice('so101_grasp_sim')?.catalog;
		const pick = grasp?.capabilities.find((capability) => capability.capabilityRef === 'pick_object');
		expect(pick?.implementation).toEqual([
			{
				kind: 'delegate',
				interfaceRef: '/manipulation/execute_pick',
				arguments: { target_name: { kind: 'param', name: 'target_name' } },
			},
		]);
		// 单臂那份没有它——两份目录真的不一样，不是同一个对象换了个名字。
		expect(
			findDevice('so101_sim')?.catalog.capabilities.some((capability) => capability.capabilityRef === 'pick_object'),
		).toBe(false);
	});

	it('一台机器的虚拟与真机**挨着**排：下拉里读起来是一对，不是两堆', () => {
		const refs = DEVICES.map((device) => device.deviceRef);
		expect(refs).toEqual(['so101_sim', 'so101_robot', 'so101_grasp_sim', 'so101_grasp_robot', 'phase1_robot']);
		// 每一对都是「虚拟在前、真机在后」——第一条永远是能立刻演的那台。
		for (let index = 0; index < refs.length - 1; index += 2) {
			expect(DEVICES[index]?.virtual, refs[index]).toBe(true);
			expect(DEVICES[index + 1]?.virtual, refs[index + 1]).toBe(false);
		}
	});
});

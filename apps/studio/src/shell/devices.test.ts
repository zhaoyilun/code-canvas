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
});

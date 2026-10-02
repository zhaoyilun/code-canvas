/**
 * 中文显示名的验收：**中文名是描述表的一部分**，所以缺一个字段、重一个名字，都得在这里红。
 *
 * 这里只查显示字段（`label`）的存在性与唯一性，不碰任何校验行为——
 * 校验行为的对照在 `parity.test.ts`（与 `docs/reference/task_protocol.py` 逐条比对）。
 */
import { describe, expect, it } from 'vitest';
import {
	ACTION_SPECS,
	ALLOWED_ACTIONS,
	LIMIT_LABELS,
	LIMIT_NAMES,
	describeActionFields,
	describeActionLabel,
	type TaskAction,
} from '../src/task-protocol';

/** 中文显示名的判据：非空、且不含 ASCII 字母（含字母就说明把英文原名抄了一遍）。 */
const CHINESE_LABEL = /^[^A-Za-z]+$/;

const actions: readonly TaskAction[] = ALLOWED_ACTIONS;

describe('动作的中文显示名', () => {
	it('七种动作每个都有中文名，且都不是英文原名', () => {
		for (const action of actions) {
			const label = describeActionLabel(action);
			expect(label, `${action} 缺中文显示名`).toBeTruthy();
			expect(label, `${action} 的显示名是英文：${label}`).toMatch(CHINESE_LABEL);
			expect(label, `${action} 的显示名抄了动作名`).not.toBe(action);
		}
	});

	it('描述表里的 label 与 ALLOWED_ACTIONS 一一对应（不多不少）', () => {
		expect(Object.keys(ACTION_SPECS).sort()).toEqual([...actions].sort());
		for (const action of actions) expect(ACTION_SPECS[action].action).toBe(action);
	});

	it('动作显示名在全集内不重复', () => {
		const labels = actions.map((action) => describeActionLabel(action));
		expect(new Set(labels).size).toBe(labels.length);
	});
});

describe('字段的中文显示名', () => {
	it('每个动作的每个字段都有中文名，一个都不许漏', () => {
		for (const action of actions) {
			const fields = describeActionFields(action);
			for (const field of fields) {
				expect(field.label, `${action}.${field.name} 缺中文显示名`).toBeTruthy();
				expect(field.label, `${action}.${field.name} 的显示名是英文：${field.label}`).toMatch(CHINESE_LABEL);
			}
		}
	});

	it('同一个动作内字段显示名不重复（跨动作重复是正常的：角速度出现在 move 与 turn）', () => {
		for (const action of actions) {
			const labels = describeActionFields(action).map((field) => field.label);
			expect(new Set(labels).size, `${action} 里有重名的字段显示名`).toBe(labels.length);
		}
	});

	it('加的是显示名，字段名与顺序照旧（机器对账仍用 name）', () => {
		expect(describeActionFields('move').map((field) => field.name)).toEqual(['linear', 'angular', 'duration']);
		expect(describeActionFields('stop_if_obstacle').map((field) => field.name)).toEqual(['sensors', 'distance']);
		expect(describeActionFields('arm_joint').map((field) => field.name)).toEqual(['joint_id', 'joint', 'time']);
		expect(describeActionFields('arm6_joints').map((field) => field.name)).toEqual([
			'joint1',
			'joint2',
			'joint3',
			'joint4',
			'joint5',
			'joint6',
			'time',
		]);
	});

	it('中文名建议值逐条落地', () => {
		const labelOf = (action: TaskAction, name: string): string | undefined =>
			describeActionFields(action).find((field) => field.name === name)?.label;

		expect(labelOf('move', 'linear')).toBe('线速度');
		expect(labelOf('move', 'angular')).toBe('角速度');
		expect(labelOf('move', 'duration')).toBe('时长');
		expect(labelOf('stop_if_obstacle', 'sensors')).toBe('传感器');
		expect(labelOf('stop_if_obstacle', 'distance')).toBe('距离');
		expect(labelOf('arm_joint', 'joint_id')).toBe('关节号');
		expect(labelOf('arm_joint', 'joint')).toBe('角度');
		expect(labelOf('arm_joint', 'time')).toBe('时长');
		expect(labelOf('arm6_joints', 'joint1')).toBe('关节1');
		expect(labelOf('arm6_joints', 'joint6')).toBe('关节6');
	});

	it('单位与范围元数据一个没丢（显示名是加出来的，不是换出来的）', () => {
		const fieldOf = (action: TaskAction, name: string) =>
			describeActionFields(action).find((field) => field.name === name);

		expect(fieldOf('move', 'linear')).toMatchObject({ unit: 'm/s', abs: true, limit: 'max_linear' });
		expect(fieldOf('move', 'angular')).toMatchObject({ unit: 'rad/s', abs: true, limit: 'max_angular' });
		expect(fieldOf('move', 'duration')).toMatchObject({ unit: 's', exclusiveMin: 0 });
		expect(fieldOf('stop_if_obstacle', 'distance')).toMatchObject({ unit: 'm', exclusiveMin: 0, max: 2 });
		expect(fieldOf('arm_joint', 'joint_id')).toMatchObject({ min: 1, max: 6, integer: true });
		expect(fieldOf('arm_joint', 'joint')).toMatchObject({ min: 0, max: 180, unit: '度' });
		expect(fieldOf('arm6_joints', 'time')).toMatchObject({ unit: 'ms', defaultValue: 1500, min: 100, max: 10000 });
	});
});

describe('限值的中文显示名', () => {
	it('LIMIT_NAMES 每一个都有中文名，且不重复', () => {
		const labels = LIMIT_NAMES.map((name) => LIMIT_LABELS[name]);
		for (const [index, name] of LIMIT_NAMES.entries()) {
			expect(labels[index], `${name} 缺中文显示名`).toBeTruthy();
			expect(labels[index]).toMatch(CHINESE_LABEL);
		}
		expect(new Set(labels).size).toBe(labels.length);
	});
});

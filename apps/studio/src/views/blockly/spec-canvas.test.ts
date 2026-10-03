// @vitest-environment happy-dom
/**
 * 块定义**按规格动态生成**：规格里有几种块面文字，就注册几个块型；
 * 实参各占一个值槽；C 形块肚子里能嵌链；值块能插进槽里。
 *
 * 这一组是「不许一块包全部」在积木那一侧的证据：同样的一个技能，
 * 一棵拆开的块树会长出好几块积木，而不是一块。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { teachingBlockCount } from '@codecanvas/contracts';
import { TEACHING_SPEC_FIXTURE } from '../../state/__fixtures__/teaching-spec';
import {
	ARG_INPUT_PREFIX,
	argInputName,
	BODY_INPUT_NAME,
	callBlockType,
	CONDITION_INPUT_NAME,
	ELSE_INPUT_NAME,
	noteBlockType,
	registerSpecBlocks,
	SPEC_BOOL_TYPE,
	SPEC_IF_ELSE_TYPE,
	SPEC_NUMBER_TYPE,
	SPEC_TEXT_TYPE,
	SPEC_WAIT_TYPE,
	specBlockDefinitions,
	specWorkspaceState,
	TEXT_FIELD_NAME,
} from './spec-canvas';

const definitions = specBlockDefinitions(TEACHING_SPEC_FIXTURE.blocks);
const byType = (type: string): Record<string, unknown> | undefined =>
	definitions.find((definition) => definition['type'] === type);

describe('块定义从规格长出来', () => {
	it('每一个块面文字长一个定义，实参各占一个值槽', () => {
		const call = byType(callBlockType('移动到观察位', false));
		expect(call).toBeDefined();
		expect(call?.['message0']).toBe('移动到观察位 pose_name %1');
		expect(call?.['args0']).toEqual([{ type: 'input_value', name: argInputName(0) }]);
		// 语句块：上下都能接（能串成链、能嵌进 C 形块）。
		expect(call?.['previousStatement']).toBeNull();
		expect(call?.['nextStatement']).toBeNull();
	});

	it('说明块、条件块、等待块、值块各有各的定义', () => {
		expect(byType(noteBlockType('先让相机正对桌面'))).toBeDefined();
		expect(byType(SPEC_IF_ELSE_TYPE)).toBeDefined();
		expect(byType(SPEC_WAIT_TYPE)).toBeDefined();
		expect(byType(SPEC_NUMBER_TYPE)).toBeDefined();
		expect(byType(SPEC_TEXT_TYPE)).toBeDefined();
		expect(byType(SPEC_BOOL_TYPE)).toBeDefined();
	});

	it('C 形块有肚子：条件一个值槽、两条链各一个语句口', () => {
		const branch = byType(SPEC_IF_ELSE_TYPE);
		expect(branch?.['message0']).toBe('如果 %1 那么 %2 否则 %3');
		expect(branch?.['args0']).toEqual([
			{ type: 'input_value', name: CONDITION_INPUT_NAME },
			{ type: 'input_statement', name: BODY_INPUT_NAME },
			{ type: 'input_statement', name: ELSE_INPUT_NAME },
		]);
	});

	it('注册是幂等的：第二次一块都不补', () => {
		const first = registerSpecBlocks(definitions);
		expect(first.length).toBeGreaterThan(0);
		expect(registerSpecBlocks(definitions)).toEqual([]);
		for (const type of first) expect(Blockly.Blocks[type]).toBeDefined();
	});

	it('值块里的调用也长定义（值槽里能再插一块）', () => {
		const blocks = [
			{
				kind: 'call' as const,
				label: '读出末端位姿',
				args: [
					{
						name: 'frame',
						value: { kind: 'call' as const, label: '当前参考系', args: [] },
					},
				],
			},
		];
		const nested = specBlockDefinitions(blocks);
		expect(nested.some((definition) => definition['type'] === callBlockType('读出末端位姿', false))).toBe(true);
		expect(nested.some((definition) => definition['type'] === callBlockType('当前参考系', true))).toBe(true);
	});
});

describe('块树 → 工作区状态', () => {
	const state = specWorkspaceState(TEACHING_SPEC_FIXTURE.blocks);

	it('顶层串成一条链：说明块 → 调用块 → 条件块', () => {
		expect(state?.type).toBe(noteBlockType('先让相机正对桌面'));
		const second = (state?.['next'] as { block?: Record<string, unknown> } | undefined)?.block;
		expect(second?.['type']).toBe(callBlockType('移动到观察位', false));
		const third = (second?.['next'] as { block?: Record<string, unknown> } | undefined)?.block;
		expect(third?.['type']).toBe(SPEC_IF_ELSE_TYPE);
	});

	it('实参是插进槽里的值块（不是块上的一行字）', () => {
		const call = (state?.['next'] as { block?: Record<string, unknown> } | undefined)?.block;
		const inputs = call?.['inputs'] as Record<string, { block?: Record<string, unknown> }> | undefined;
		expect(inputs?.[`${ARG_INPUT_PREFIX}0`]?.block?.['type']).toBe(SPEC_TEXT_TYPE);
		expect((inputs?.[`${ARG_INPUT_PREFIX}0`]?.block?.['fields'] as Record<string, unknown>)?.[TEXT_FIELD_NAME]).toBe(
			'observe_table',
		);
	});

	it('C 形块肚子里嵌着链：then 是调用块、else 是等待块', () => {
		const branch = (state?.['next'] as { block?: Record<string, unknown> } | undefined)?.block?.['next'] as
			| { block?: Record<string, unknown> }
			| undefined;
		const inputs = branch?.block?.['inputs'] as Record<string, { block?: Record<string, unknown> }> | undefined;
		expect(inputs?.[CONDITION_INPUT_NAME]?.block?.['type']).toBe(SPEC_BOOL_TYPE);
		expect(inputs?.[BODY_INPUT_NAME]?.block?.['type']).toBe(callBlockType('合上夹爪', false));
		expect(inputs?.[ELSE_INPUT_NAME]?.block?.['type']).toBe(SPEC_WAIT_TYPE);
	});

	it('一棵拆开的树块数远多于「一块包全部」：数值槽也算一块', () => {
		// 顶层 3 块（说明 / 调用 / 条件）+ 实参值块 1 + 判据 1 + 肚子里调用 1 + 等待 1 + 秒数 1 = 8
		expect(teachingBlockCount(TEACHING_SPEC_FIXTURE.blocks)).toBe(8);
		expect(teachingBlockCount([{ kind: 'call', label: '看一眼桌面', args: [] }])).toBe(1);
	});
});

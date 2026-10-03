/**
 * 积木画布的新接线：画**教学规格里的块树**。
 *
 * 与从前的 `useBlocklyCanvas` 的区别只有一处，但那一处是根本的：**块的定义从规格来**，
 * 不再从目录里的实现树来。从前 `buildBlockDefinition(shape)` 的输入是
 * `capability.implementation`（一棵由原语组成的语句树）——于是 `inspect_scene` 只有一块积木；
 * 现在输入的是模型写的块树，同一个技能可以是「靠近 → 合爪 → 抬起 → 验证」好几块，
 * 还能带实参值块、C 形块、嵌套链。
 *
 * 块的定义**按规格动态生成**（不是一套写死的块型加字段）：每个不同的块面文字长一个定义，
 * `message0` 里就是那句话，实参各占一个值槽。定义与注册在同一处，重画时只补没注册过的
 * （Blockly 把 `message0` 烘进 `init`，注册完读不回来——所以注册前那份定义也是验收读的那份）。
 *
 * 只读：这些积木讲的是「这件事怎么做」，不是机器要执行的那份契约（那是 `state/document.ts`
 * 的声明，写它的通道一个字都没变）。所以工作区 `readOnly`、没有工具箱、没有垃圾桶
 * ——摆出来的是讲解，不是可以拖来拖去的东西。
 *
 * 铺开的节奏由 `state/teaching.ts` 的播放队列给（`revealedCount` / 对象身份）。
 * 这里做两件事：整棵树**一次画完**（位置因此稳定，不会一边铺一边挪），
 * 然后把还没轮到的那几块先按住（透明、不吃指针），轮到时再调
 * `playBlockStepEntrance` 让那一块「从工具箱方向拖进来、落位」。
 *
 * 这一版多接了一条线：**设备执行到哪一步 → 切到那一步的块**。判据是规格里那块积木的
 * 归属（`data-cc-plan-node`）与当前步在流程图上对应的那个框是否同一个 id；
 * 「切过去」只有两件不动坐标的事（挂属性 + 滚视口），**`transform` 一个字节都不碰**
 * ——块的定位与命中区都靠它（见 `useSpecCanvas` 的注释）。
 */
import * as Blockly from 'blockly';
import { onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { TeachingBlock, TeachingSpec, TeachingValueBlock } from '@codecanvas/contracts';
import { buildInjectOptions, fitWorkspaceToContent, paletteFromDocument } from '@codecanvas/blockly-toolkit';
import { playBlockStepEntrance } from './blockly-canvas';

/** 块型前缀：语句块 `cc_spec_do_*`、值块 `cc_spec_value_*`、说明块 `cc_spec_note_*`。 */
export const SPEC_DO_PREFIX = 'cc_spec_do_';
export const SPEC_VALUE_PREFIX = 'cc_spec_value_';
export const SPEC_NOTE_PREFIX = 'cc_spec_note_';
export const SPEC_IF_TYPE = 'cc_spec_if';
export const SPEC_IF_ELSE_TYPE = 'cc_spec_if_else';
export const SPEC_REPEAT_TYPE = 'cc_spec_repeat';
export const SPEC_WAIT_TYPE = 'cc_spec_wait';
export const SPEC_NUMBER_TYPE = 'cc_spec_number';
export const SPEC_TEXT_TYPE = 'cc_spec_text';
export const SPEC_BOOL_TYPE = 'cc_spec_bool';

/** 第 n 个实参的值槽名。用**下标**而不是实参名：块面文字已经把实参名写出来了。 */
export const ARG_INPUT_PREFIX = 'ARG_';
export const argInputName = (index: number): string => `${ARG_INPUT_PREFIX}${String(index)}`;

export const CONDITION_INPUT_NAME = 'CONDITION';
export const BODY_INPUT_NAME = 'BODY';
export const ELSE_INPUT_NAME = 'ELSE';
export const TIMES_INPUT_NAME = 'TIMES';
export const SECONDS_INPUT_NAME = 'SECONDS';
export const NUMBER_FIELD_NAME = 'NUMBER';
export const TEXT_FIELD_NAME = 'TEXT';
export const BOOL_FIELD_NAME = 'BOOL';

/** 内容装不下时，左上角留出的那点边距（像素）。 */
const FIT_MARGIN_PX = 16;

/** 还没轮到的那一块：按住（透明、不吃指针），轮到时把类摘掉再让它入场。 */
export const SPEC_PENDING_CLASS = 'cc-spec-pending';

/** 块元素上的三个验收属性：铺开序（第几格）、树里的层数、块型。 */
export const SPEC_INDEX_ATTRIBUTE = 'data-cc-spec-index';
export const SPEC_DEPTH_ATTRIBUTE = 'data-cc-spec-depth';
export const SPEC_TYPE_ATTRIBUTE = 'data-cc-spec-type';

/**
 * 这一块**属于哪个流程节点**（规格里那块积木的 `planPath`，落成属性）。
 *
 * 它是「切到那一步的块」的判据：规格里的锚与当前步在流程图上对应的那个框是同一个 id，
 * 三处（流程图 / 积木 / 代码）于是说的是同一件事。**没有归属的块不挂这个属性**
 * ——空属性值会读成「归属是空字符串」，那是两回事。
 */
export const SPEC_PLAN_ATTRIBUTE = 'data-cc-plan-node';

/** 设备此刻走到的那一步落在哪一块/哪几块上（`SPEC_PLAN_ATTRIBUTE` 等于当前节点的块）。 */
export const SPEC_CURRENT_ATTRIBUTE = 'data-cc-current-block';

/** 块面文字里那个 `%` 要挡一下：Blockly 把 `%1` 当占位符，模型写的百分号会吃掉一个槽。 */
const escapeMessage = (text: string): string => text.replace(/%(?=\d)/g, '％');

/** 文字 → 稳定的类型后缀（同一句话永远同一个类型；一句话不同则不同）。 */
const slugOf = (text: string): string => {
	let hash = 0x811c9dc5;
	for (const character of text) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
};

export const callBlockType = (label: string, isValue: boolean): string =>
	`${isValue ? SPEC_VALUE_PREFIX : SPEC_DO_PREFIX}${slugOf(label)}`;
export const noteBlockType = (text: string): string => `${SPEC_NOTE_PREFIX}${slugOf(text)}`;

/** 实参名 → 一行块面文字：`pose_name %1`。 */
const argumentField = (name: string, index: number): string =>
	`${escapeMessage(name)} %${String(index + 1)}`;

const callDefinition = (
	type: string,
	blockLabel: string,
	argumentNames: readonly string[],
	isValue: boolean,
	style: string,
): Record<string, unknown> => {
	const placeholders = argumentNames.map((name, index) => argumentField(name, index));
	return {
		type,
		message0: [escapeMessage(blockLabel), ...placeholders].join(' '),
		args0: argumentNames.map((_, index) => ({ type: 'input_value', name: argInputName(index) })),
		...(isValue ? { output: null } : { previousStatement: null, nextStatement: null }),
		style,
		tooltip: blockLabel,
		helpUrl: '',
	};
};

/**
 * 规格里的块树 → Blockly 块定义数组（**去重**：同一句话只注册一个类型）。
 *
 * 语句块与值块分开：值块有 `output`（能插进槽里），语句块有上下两个连接（能串成链、能嵌进 C 形块）。
 */
export const specBlockDefinitions = (blocks: readonly TeachingBlock[]): readonly Record<string, unknown>[] => {
	const definitions = new Map<string, Record<string, unknown>>();

	const addCall = (label: string, argumentNames: readonly string[], isValue: boolean): void => {
		const type = callBlockType(label, isValue);
		if (definitions.has(type)) return;
		definitions.set(type, callDefinition(type, label, argumentNames, isValue, isValue ? 'text_blocks' : 'procedure_blocks'));
	};

	const addValue = (block: TeachingValueBlock): void => {
		if (block.kind === 'call') {
			addCall(block.label ?? '', (block.args ?? []).map((argument) => argument.name), true);
			for (const argument of block.args ?? []) addValue(argument.value);
		}
	};

	const walk = (block: TeachingBlock): void => {
		if (block.kind === 'call') {
			addCall(block.label ?? '', (block.args ?? []).map((argument) => argument.name), false);
			for (const argument of block.args ?? []) addValue(argument.value);
			return;
		}
		if (block.kind === 'if') {
			addValue(block.condition as TeachingValueBlock);
			for (const child of block.body ?? []) walk(child);
			for (const child of block.otherwise ?? []) walk(child);
			return;
		}
		if (block.kind === 'repeat') {
			addValue(block.times as TeachingValueBlock);
			for (const child of block.body ?? []) walk(child);
			return;
		}
		if (block.kind === 'wait') {
			addValue(block.seconds as TeachingValueBlock);
			return;
		}
		const type = noteBlockType(block.text ?? '');
		if (definitions.has(type)) return;
		definitions.set(type, {
			type,
			message0: `讲解：${escapeMessage(block.text ?? '')}`,
			args0: [],
			previousStatement: null,
			nextStatement: null,
			style: 'logic_blocks',
			tooltip: block.text ?? '',
			helpUrl: '',
		});
	};

	for (const block of blocks) walk(block);

	// 三种值块（数字 / 文本 / 布尔）是固定块型：值写在字段里，不各长一个定义。
	definitions.set(SPEC_IF_TYPE, {
		type: SPEC_IF_TYPE,
		message0: '如果 %1 那么 %2',
		args0: [
			{ type: 'input_value', name: CONDITION_INPUT_NAME },
			{ type: 'input_statement', name: BODY_INPUT_NAME },
		],
		previousStatement: null,
		nextStatement: null,
		style: 'logic_blocks',
		tooltip: '条件成立就走肚子里那条链',
		helpUrl: '',
	});
	definitions.set(SPEC_IF_ELSE_TYPE, {
		type: SPEC_IF_ELSE_TYPE,
		message0: '如果 %1 那么 %2 否则 %3',
		args0: [
			{ type: 'input_value', name: CONDITION_INPUT_NAME },
			{ type: 'input_statement', name: BODY_INPUT_NAME },
			{ type: 'input_statement', name: ELSE_INPUT_NAME },
		],
		previousStatement: null,
		nextStatement: null,
		style: 'logic_blocks',
		tooltip: '条件成立走「那么」，不成立走「否则」',
		helpUrl: '',
	});
	definitions.set(SPEC_REPEAT_TYPE, {
		type: SPEC_REPEAT_TYPE,
		message0: '重复 %1 次 %2',
		args0: [
			{ type: 'input_value', name: TIMES_INPUT_NAME },
			{ type: 'input_statement', name: BODY_INPUT_NAME },
		],
		previousStatement: null,
		nextStatement: null,
		style: 'loop_blocks',
		tooltip: '重复做肚子里那条链',
		helpUrl: '',
	});
	definitions.set(SPEC_WAIT_TYPE, {
		type: SPEC_WAIT_TYPE,
		message0: '等待 %1 秒',
		args0: [{ type: 'input_value', name: SECONDS_INPUT_NAME }],
		previousStatement: null,
		nextStatement: null,
		style: 'procedure_blocks',
		tooltip: '在这里停一下',
		helpUrl: '',
	});
	definitions.set(SPEC_NUMBER_TYPE, {
		type: SPEC_NUMBER_TYPE,
		message0: '%1',
		args0: [{ type: 'field_number', name: NUMBER_FIELD_NAME, value: 0 }],
		output: null,
		style: 'math_blocks',
		tooltip: '一个数',
		helpUrl: '',
	});
	definitions.set(SPEC_TEXT_TYPE, {
		type: SPEC_TEXT_TYPE,
		message0: '%1',
		args0: [{ type: 'field_input', name: TEXT_FIELD_NAME, text: '' }],
		output: null,
		style: 'text_blocks',
		tooltip: '一段文字',
		helpUrl: '',
	});
	definitions.set(SPEC_BOOL_TYPE, {
		type: SPEC_BOOL_TYPE,
		message0: '%1',
		args0: [
			{
				type: 'field_dropdown',
				name: BOOL_FIELD_NAME,
				options: [
					['true', 'true'],
					['false', 'false'],
				],
			},
		],
		output: null,
		style: 'logic_blocks',
		tooltip: '真 / 假',
		helpUrl: '',
	});

	return [...definitions.values()];
};

/** 补注册没注册过的块型。重复注册不会覆盖（Blockly 自己是幂等的），这里只省一次调用。 */
export const registerSpecBlocks = (definitions: readonly Record<string, unknown>[]): readonly string[] => {
	const fresh = definitions.filter((definition) => Blockly.Blocks[definition['type'] as string] === undefined);
	if (fresh.length > 0) Blockly.defineBlocksWithJsonArray([...fresh]);
	return fresh.map((definition) => definition['type'] as string);
};

/** 值块 → Blockly 状态。 */
const valueState = (block: TeachingValueBlock): Blockly.serialization.blocks.State => {
	if (block.kind === 'number') return { type: SPEC_NUMBER_TYPE, fields: { [NUMBER_FIELD_NAME]: block.value ?? 0 } };
	if (block.kind === 'text') return { type: SPEC_TEXT_TYPE, fields: { [TEXT_FIELD_NAME]: block.value ?? '' } };
	if (block.kind === 'bool') {
		return { type: SPEC_BOOL_TYPE, fields: { [BOOL_FIELD_NAME]: block.value === true ? 'true' : 'false' } };
	}
	const inputs: Record<string, Blockly.serialization.blocks.ConnectionState> = {};
	(block.args ?? []).forEach((argument, index) => {
		inputs[argInputName(index)] = { block: valueState(argument.value) };
	});
	return {
		type: callBlockType(block.label ?? '', true),
		...(Object.keys(inputs).length === 0 ? {} : { inputs }),
	};
};

/** 一条语句链 → 首块（`next` 串起来）。 */
const chainState = (blocks: readonly TeachingBlock[]): Blockly.serialization.blocks.State | null => {
	const states = blocks.map((block) => statementState(block));
	for (let index = states.length - 1; index > 0; index -= 1) {
		const previous = states[index - 1];
		const current = states[index];
		if (previous === undefined || current === undefined) continue;
		previous['next'] = { block: current };
	}
	return states[0] ?? null;
};

/** 一个语句块 → Blockly 状态（C 形块递归下去）。 */
const statementState = (block: TeachingBlock): Blockly.serialization.blocks.State => {
	if (block.kind === 'call') {
		const inputs: Record<string, Blockly.serialization.blocks.ConnectionState> = {};
		(block.args ?? []).forEach((argument, index) => {
			inputs[argInputName(index)] = { block: valueState(argument.value) };
		});
		return {
			type: callBlockType(block.label ?? '', false),
			...(Object.keys(inputs).length === 0 ? {} : { inputs }),
		};
	}
	if (block.kind === 'if') {
		const inputs: Record<string, Blockly.serialization.blocks.ConnectionState> = {};
		if (block.condition !== undefined) inputs[CONDITION_INPUT_NAME] = { block: valueState(block.condition) };
		const body = chainState(block.body ?? []);
		if (body !== null) inputs[BODY_INPUT_NAME] = { block: body };
		const otherwise = chainState(block.otherwise ?? []);
		if (otherwise !== null) inputs[ELSE_INPUT_NAME] = { block: otherwise };
		return { type: otherwise === null ? SPEC_IF_TYPE : SPEC_IF_ELSE_TYPE, inputs };
	}
	if (block.kind === 'repeat') {
		const inputs: Record<string, Blockly.serialization.blocks.ConnectionState> = {};
		if (block.times !== undefined) inputs[TIMES_INPUT_NAME] = { block: valueState(block.times) };
		const body = chainState(block.body ?? []);
		if (body !== null) inputs[BODY_INPUT_NAME] = { block: body };
		return { type: SPEC_REPEAT_TYPE, inputs };
	}
	if (block.kind === 'wait') {
		return {
			type: SPEC_WAIT_TYPE,
			inputs: block.seconds === undefined ? {} : { [SECONDS_INPUT_NAME]: { block: valueState(block.seconds) } },
		};
	}
	return { type: noteBlockType(block.text ?? '') };
};

/** 一棵块树 → 工作区状态（顶层串成一条链）。 */
export const specWorkspaceState = (
	blocks: readonly TeachingBlock[],
): Blockly.serialization.blocks.State | null => chainState(blocks);

/**
 * 工作区里的块，**深度优先、先父后子**（与规格树那边的铺开序是同一个序）。
 *
 * `depth` 是这一块在树里的层数（顶层 0、C 形块肚子里的 1、再嵌的 2）——
 * 它是「嵌套」这件事在 DOM 上唯一说得准的凭据（积木的位置是 SVG 坐标，肉眼分不出是嵌进去的
 * 还是碰巧排在那儿）。验收脚本读它，规则与从前那个 `data-cc-step-path` 一样：
 * **不靠肉眼认积木**。
 */
export interface SpecBlockEntry {
	readonly block: Blockly.BlockSvg;
	readonly depth: number;
}

export const depthFirstSpecBlocks = (workspace: Blockly.WorkspaceSvg): readonly SpecBlockEntry[] => {
	const out: SpecBlockEntry[] = [];
	const visit = (block: Blockly.BlockSvg, depth: number): void => {
		out.push({ block, depth });
		for (const child of block.getChildren(true)) visit(child as Blockly.BlockSvg, depth + 1);
	};
	for (const top of workspace.getTopBlocks(true)) visit(top, 0);
	return out;
};

export interface UseSpecCanvasResult {
	readonly hostRef: Ref<HTMLElement | null>;
	readonly failure: Ref<string | null>;
	readonly blockCount: Ref<number>;
	/** 设备当前那一步落在画布上的哪几块（块的铺开序）。空表 = 这一份没有归属对得上。 */
	readonly currentBlockIndexes: Ref<readonly number[]>;
}

/**
 * 建画布 + 跟着规格重画 + 跟着播放队列铺开 + 跟着当前步切过去。
 *
 * 四件事分开做：`spec` 变 → 重画（定义补齐、状态换掉、块数重置）；`revealedCount` 变 →
 * 只改「哪几块露出来」，**不重画**（重画会把位置与已经入场的块一起抹掉）；
 * `currentNodeId` 变 → 只挪「当前步」那一个标记（并在必要时把画布滚过去）。
 *
 * **不碰 `transform`**：Blockly 给每个块的 `<g>` 写着 `transform="translate(x, y)"`，
 * 块的定位与命中区都靠它（CSS 的 `transform` 会整个盖掉那个属性）。所以这一版的
 * 「切过去」只有两件不动坐标的事：给块挂一个属性（CSS 用 `filter` 画那圈辉光），
 * 以及 `workspace.scroll()`（动的是画布视口，不是块）。
 */
export const useSpecCanvas = (options: {
	readonly spec: Ref<TeachingSpec | null>;
	readonly revealedCount: Ref<number>;
	/** 每一块的归属（与画布的深度优先序同序、一格对一格）；`state/teaching.ts` 给的。 */
	readonly anchors?: Ref<readonly (string | undefined)[]>;
	/** 设备此刻走到的那一步对应哪个流程节点（空串 = 没有）。 */
	readonly currentNodeId?: Ref<string>;
}): UseSpecCanvasResult => {
	const hostRef = ref<HTMLElement | null>(null);
	const failure = ref<string | null>(null);
	const blockCount = ref(0);
	const currentBlockIndexes = ref<readonly number[]>([]);

	let workspace: Blockly.WorkspaceSvg | null = null;
	/** 已经入过场的那几块：同一块不重复拖第二遍（`playBlockStepEntrance` 自己会重放，代价是白闪一下）。 */
	let entered = new WeakSet<Element>();

	const reveal = (): void => {
		if (workspace === null) return;
		const blocks = depthFirstSpecBlocks(workspace);
		const anchors = options.anchors?.value ?? [];
		blocks.forEach((entry, index) => {
			const element = entry.block.getSvgRoot();
			if (!(element instanceof Element)) return;
			// 验收与调试读这几个属性认块（铺开序、树里的层数、块型、归属哪个流程节点）——
			// 与从前那套 `data-cc-step-path` 同一个用意：不靠肉眼认积木。
			element.setAttribute(SPEC_INDEX_ATTRIBUTE, String(index));
			element.setAttribute(SPEC_DEPTH_ATTRIBUTE, String(entry.depth));
			element.setAttribute(SPEC_TYPE_ATTRIBUTE, entry.block.type);
			const anchor = anchors[index];
			if (anchor === undefined) element.removeAttribute(SPEC_PLAN_ATTRIBUTE);
			else element.setAttribute(SPEC_PLAN_ATTRIBUTE, anchor);
			if (index >= options.revealedCount.value) {
				element.classList.add(SPEC_PENDING_CLASS);
				return;
			}
			element.classList.remove(SPEC_PENDING_CLASS);
			if (entered.has(element)) return;
			entered.add(element);
			playBlockStepEntrance(element);
		});
	};

	/**
	 * 当前步 → 那几块：挂标记 + 滚过去。
	 *
	 * **一次遍历干完**（与 `reveal` 同一份幂等写法）：先摘掉上一轮的标记，再给对上的挂上。
	 * 一个流程节点可能对应好几块（一个技能拆成父块 + 子块 + 值块），所以是「哪几块」而不是
	 * 「哪一块」——全挂上，屏幕上就是「这一步讲的是这几块」。
	 */
	const syncCurrent = (): void => {
		const current = workspace;
		if (current === null) return;
		const wanted = options.currentNodeId?.value ?? '';
		const anchors = options.anchors?.value ?? [];
		const hits: number[] = [];
		depthFirstSpecBlocks(current).forEach((entry, index) => {
			const element = entry.block.getSvgRoot();
			if (!(element instanceof Element)) return;
			// 归属在 `reveal` 里挂（那里才是画布与规格对齐的地方）；这里只读它。
			const anchored = wanted !== '' && anchors[index] === wanted;
			if (anchored) {
				hits.push(index);
				element.setAttribute(SPEC_CURRENT_ATTRIBUTE, wanted);
			} else {
				element.removeAttribute(SPEC_CURRENT_ATTRIBUTE);
			}
		});
		currentBlockIndexes.value = hits;
		if (hits.length === 0) return;
		scrollIntoView(current, depthFirstSpecBlocks(current)[hits[0] as number]?.block ?? null);
	};

	/**
	 * 把那一块挪进可视区。**动的是画布视口**（`workspace.scroll`），不是块的坐标
	 * ——块的 `transform` 由 Blockly 管，碰它命中区就错位了。
	 *
	 * 已经看得见就不动：画布是「整棵树一次画完 + 自适应缩小」的，绝大多数时候全都看得见，
	 * 每次都滚一下只会让画面自己抖。看不见（缩放下限装不下时）才滚。
	 */
	const scrollIntoView = (current: Blockly.WorkspaceSvg, block: Blockly.BlockSvg | null): void => {
		if (block === null) return;
		const box = block.getBoundingRectangle();
		const metrics = current.getMetrics();
		const scale = current.scale;
		const within =
			box.left * scale >= 0 &&
			box.top * scale >= 0 &&
			box.getWidth() * scale <= metrics.viewWidth &&
			box.getHeight() * scale <= metrics.viewHeight;
		if (within) return;
		current.scroll(
			metrics.viewWidth / 2 - (box.left + box.getWidth() / 2) * scale,
			metrics.viewHeight / 2 - (box.top + box.getHeight() / 2) * scale,
		);
	};

	const render = (spec: TeachingSpec | null): void => {
		if (hostRef.value === null) return;
		if (spec === null) return;
		try {
			const definitions = specBlockDefinitions(spec.blocks);
			registerSpecBlocks(definitions);
			if (workspace === null) {
				workspace = Blockly.inject(hostRef.value, buildInjectOptions(paletteFromDocument(), [], true));
			}
			workspace.clear();
			entered = new WeakSet<Element>();
			const state = specWorkspaceState(spec.blocks);
			// `blocks.append`（不是 `workspaces.load`）：我们给的是一棵**块状态**（顶层串成一条链），
			// 而 `workspaces.load` 要的是整个工作区的状态（`{blocks: [...]}`）。给错了它不报错，
			// 只是什么都不画——实测在真浏览器里就是「画布上 0 块」。同一张表在
			// `@codecanvas/blockly-toolkit` 的 `renderDeclaration` 里也是这么接的。
			if (state !== null) Blockly.serialization.blocks.append(state, workspace);
			blockCount.value = depthFirstSpecBlocks(workspace).length;
			failure.value = null;
			// 位置一次性定下来：先铺开（还没轮到的块也在，只是被按住）再自适应缩放，
			// 于是铺开过程中画布不会自己动。
			reveal();
			const fit = fitWorkspaceToContent(workspace);
			/*
			 * 装不下时**靠左对齐**，不居中。
			 *
			 * 教学块的注释可以很长（一句话就是一块），内容宽度常常超过一栏——而可读下限
			 * （`MIN_READABLE_SCALE` = 0.6）是刻意的：再缩字就没了。装不下时如果照旧居中，
			 * 屏幕上是**两头都被切掉**的中段：既看不见链的头，也不知道该往哪边滚。
			 * 对齐到左上角之后，第一块就在眼前，剩下的横向滚动看——这与「画布可以滚」是同一件事。
			 */
			if (fit !== null && !fit.fits) {
				const box = workspace.getBlocksBoundingBox();
				workspace.scroll(FIT_MARGIN_PX - box.left * fit.scale, FIT_MARGIN_PX - box.top * fit.scale);
			}
			// 画完就对一次当前步：重画这件事本身不该把「设备跑到哪一块」的标记抹掉。
			syncCurrent();
		} catch (error) {
			// 画不出来就照实说：这一栏不能空着，也不能显示一棵半截的树。
			failure.value = error instanceof Error ? error.message : String(error);
		}
	};

	onMounted(() => {
		render(options.spec.value);
	});

	watch(options.spec, (spec) => {
		render(spec);
	});

	watch(options.revealedCount, () => {
		reveal();
	});

	// 归属与当前步：两条都只是「挪标记」，不重画（重画会把位置与已经入场的块一起抹掉）。
	if (options.anchors !== undefined) watch(options.anchors, () => reveal());
	if (options.currentNodeId !== undefined) watch(options.currentNodeId, () => syncCurrent());

	onBeforeUnmount(() => {
		workspace?.dispose();
		workspace = null;
	});

	return { hostRef, failure, blockCount, currentBlockIndexes };
};

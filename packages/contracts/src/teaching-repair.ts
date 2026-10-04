/**
 * 教学规格的**修补层**：形状过了但"表达方式不一样"的地方，在本地机械地修掉，
 * 不拿一次模型往返去换。
 *
 * 为什么要这一层（2026-10 的教训）：
 *
 * 那一天输入「旋转360度」，任务只有一步，模型为了讲清楚加了个"等旋转走完"的等待框，
 * 并给它编了一个越界的 `planPath`。整份规格被拒，三块画布全空，用户看到四个字"形状不对"。
 * 我们第一反应是"把提示词写清楚"——**那是治不好的**：只要契约比语义更严，
 * 模型就永远有两难（不写=形状不过，写=只能是编的），换一个模型只会换一种踩法。
 *
 * 真正的分界不是"严不严"，是**严在哪一层**：
 *
 * | 这一层 | 该不该严 | 为什么 |
 * | --- | --- | --- |
 * | 机器要吃的那份（任务协议、能力白名单、限值） | **必须严** | 错了会驱动真机，没有"修一修"的余地 |
 * | 给人看的那份（这一份：教学规格） | **不该严** | 讲错了最坏是讲解不准，不会动设备 |
 *
 * 所以这一层的规矩是：**能机械修的，绝不用拒**；修不了的（缺开始节点、块树连不成一棵、
 * 代码段拼不出来）才拒——那些是真"说不通"，不是"说得不一样"。
 *
 * 三条纪律：
 *
 * 1. **每一次修补都要留痕**（`notes`），并且逐条摆给用户看。偷偷改掉模型的话，
 *    等于把"屏幕上这句话是谁说的"搅浑了——那比拒掉更坏。
 * 2. **只做有确定答案的修补**。多一个键、少一个路径、`"3"` 写成 `3`——这些只有一种改法。
 *    拿不准的一律不动（比如"这句话到底指哪一步"，我们猜不了）。
 * 3. **修完必须重新过一遍契约**。修补层不是"绕过校验"，它是把校验搬到了修完之后。
 */
import {
	PLAN_PATH_PATTERN,
	teachingSpecSchema,
	type TeachingBlock,
	type TeachingValueBlock,
} from './teaching-spec';

/** 一次修补：改了什么、为什么。`path` 是出事的位置（`flow.nodes[2].planPath` 这种）。 */
export interface SpecRepair {
	readonly path: string;
	readonly what: string;
}

export interface RepairOutcome {
	readonly value: unknown;
	readonly repairs: readonly SpecRepair[];
}

/**
 * 修补时的上下文。
 *
 * `knownPlanPaths` 是**这次任务真的会走到的那几条路径**（`planPathsOf(declaration)` 的产物）。
 * 给它，修补层才判得了"这条路在不在声明里"；不给就只能判语法。
 *
 * 为什么这一格必须是参数而不是"回头再对账"：用户那次踩的正是**语法合法但声明里没有**的路径
 * （`"2"`，可任务只有一步）。只判语法的话它照样通过，然后在下一层被拒——三块画布全空。
 */
export interface RepairContext {
	readonly knownPlanPaths?: readonly string[];
}

/** 认得出、也只认这些键——超出的键一律摘掉（定稿的契约里就这几套键，见 `teaching-spec.ts`）。 */
const NODE_KEYS = new Set(['id', 'kind', 'title', 'detail', 'planPath']);
const EDGE_KEYS = new Set(['from', 'to', 'arm', 'label']);
const GRAPH_KEYS = new Set(['nodes', 'edges']);
const BLOCK_KEYS: Readonly<Record<string, readonly string[]>> = {
	call: ['kind', 'label', 'args', 'planPath'],
	if: ['kind', 'condition', 'body', 'otherwise', 'planPath'],
	repeat: ['kind', 'times', 'body', 'planPath'],
	wait: ['kind', 'seconds', 'planPath'],
	note: ['kind', 'text', 'planPath'],
};
const VALUE_KEYS: Readonly<Record<string, readonly string[]>> = {
	number: ['kind', 'value'],
	text: ['kind', 'value'],
	bool: ['kind', 'value'],
	call: ['kind', 'label', 'args'],
};
const ARG_KEYS = new Set(['name', 'value']);
const SEGMENT_KEYS = new Set(['planPath', 'lines']);
const SPEC_KEYS = new Set(['version', 'title', 'flow', 'blocks', 'codeSegments']);

/**
 * 文本上限：**取契约里的数**（`title` 64 / `detail` 120 / 讲解词 200 / 代码行 400）。
 *
 * 为什么裁到契约的数而不是"随便截短一点"：截完还要过契约，短于它才过得了。
 * 这些上限本来就是版面考虑（一行字放不下），不是"说不通"，所以超了截断、不拒。
 */
const TITLE_MAX = 64;
const DETAIL_MAX = 120;
const NOTE_MAX = 200;
const LINE_MAX = 400;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** 摘掉不在白名单里的键；只动"多出来的"，不动缺失的。 */
const stripKeys = (
	source: Record<string, unknown>,
	allowed: ReadonlySet<string> | readonly string[],
	path: string,
	repairs: SpecRepair[],
): Record<string, unknown> => {
	const keys: ReadonlySet<string> = Array.isArray(allowed) ? new Set<string>(allowed as readonly string[]) : (allowed as ReadonlySet<string>);
	const extra = Object.keys(source).filter((key) => !keys.has(key));
	if (extra.length === 0) return source;
	const kept: Record<string, unknown> = {};
	for (const key of Object.keys(source)) if (keys.has(key)) kept[key] = source[key];
	repairs.push({ path, what: `摘掉不认识的字：${extra.join('、')}` });
	return kept;
};

/** `"0.03"` → `0.03`；只认纯数字串，`"0.03m"` 这种带单位的**不动**（那要人判断，不猜）。 */
const asNumber = (value: unknown): number | null => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
	return null;
};

const clampText = (value: unknown, max: number, path: string, repairs: SpecRepair[]): unknown => {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (trimmed.length === 0) return trimmed;
	if (trimmed.length <= max) return trimmed;
	repairs.push({ path, what: `太长（${trimmed.length} 字）截到 ${max} 字` });
	return trimmed.slice(0, max);
};

/** 值块：摘多余键 + 数值串还原成数。 */
const repairValue = (raw: unknown, path: string, repairs: SpecRepair[]): unknown => {
	if (!isRecord(raw)) return raw;
	const kind = typeof raw['kind'] === 'string' ? raw['kind'] : '';
	const allowed = VALUE_KEYS[kind];
	let value: Record<string, unknown> = allowed === undefined ? raw : stripKeys(raw, allowed, path, repairs);
	if (kind === 'number') {
		const number = asNumber(value['value']);
		if (number !== null && number !== value['value']) {
			repairs.push({ path: `${path}.value`, what: `数值写成字符串 ${JSON.stringify(value['value'])}，还原成数` });
			value = { ...value, value: number };
		}
	}
	if (kind === 'bool' && typeof value['value'] === 'string') {
		const text = value['value'].trim().toLowerCase();
		if (text === 'true' || text === 'false') {
			repairs.push({ path: `${path}.value`, what: `真假写成字符串 ${JSON.stringify(value['value'])}，还原成布尔` });
			value = { ...value, value: text === 'true' };
		}
	}
	if (kind === 'text') {
		value = { ...value, value: clampText(value['value'], 200, `${path}.value`, repairs) };
	}
	if (kind === 'call') {
		if (Array.isArray(value['args'])) {
			value = {
				...value,
				args: value['args'].slice(0, 6).map((argument, index) => repairArgument(argument, `${path}.args[${index}]`, repairs)),
			};
		}
	}
	return value;
};

const repairArgument = (raw: unknown, path: string, repairs: SpecRepair[]): unknown => {
	if (!isRecord(raw)) return raw;
	const stripped = stripKeys(raw, ARG_KEYS, path, repairs);
	return { ...stripped, value: repairValue(stripped['value'], `${path}.value`, repairs) };
};

/** 语句块：摘多余键（`call` 上多个 `body` 是模型最爱犯的）、递归修子树。 */
const repairBlock = (raw: unknown, path: string, repairs: SpecRepair[]): unknown => {
	if (!isRecord(raw)) return raw;
	const kind = typeof raw['kind'] === 'string' ? raw['kind'] : '';
	const allowed = BLOCK_KEYS[kind];
	const value: Record<string, unknown> = allowed === undefined ? raw : stripKeys(raw, allowed, path, repairs);
	const next: Record<string, unknown> = { ...value };
	if (Array.isArray(value['args'])) {
		next['args'] = value['args']
			.slice(0, 8)
			.map((argument, index) => repairArgument(argument, `${path}.args[${index}]`, repairs));
	}
	for (const chainKey of ['body', 'otherwise'] as const) {
		const chain = value[chainKey];
		if (Array.isArray(chain)) {
			next[chainKey] = chain.map((child, index) => repairBlock(child, `${path}.${chainKey}[${index}]`, repairs));
		}
	}
	if (value['condition'] !== undefined) next['condition'] = repairValue(value['condition'], `${path}.condition`, repairs);
	if (value['times'] !== undefined) next['times'] = repairValue(value['times'], `${path}.times`, repairs);
	if (value['seconds'] !== undefined) next['seconds'] = repairValue(value['seconds'], `${path}.seconds`, repairs);
	if (kind === 'note') next['text'] = clampText(value['text'], NOTE_MAX, `${path}.text`, repairs);
	return next;
};

/**
 * 顶层入口：把模型给的东西照着契约的形状修一遍。
 *
 * 只修**有确定答案**的地方；修不了的照原样留着，交给契约去拒——那一层的错要原样
 * 交回给模型（`issues` 就是模型的下一轮指令），所以我们不替它猜。
 */
export const repairTeachingSpec = (raw: unknown, context: RepairContext = {}): RepairOutcome => {
	const repairs: SpecRepair[] = [];
	if (!isRecord(raw)) return { value: raw, repairs };
	const known = context.knownPlanPaths === undefined ? null : new Set(context.knownPlanPaths);

	let spec = stripKeys(raw, SPEC_KEYS, '(根)', repairs);
	spec = { ...spec, title: clampText(spec['title'], TITLE_MAX, 'title', repairs) };

	// ① 流程图：摘多余键、修文本长度、把编出来的 planPath 去掉。
	const flow = spec['flow'];
	if (isRecord(flow)) {
		const graph = stripKeys(flow, GRAPH_KEYS, 'flow', repairs);
		const nodes = Array.isArray(graph['nodes']) ? graph['nodes'] : [];
		const edges = Array.isArray(graph['edges']) ? graph['edges'] : [];
		const repairedNodes = nodes.map((rawNode, index) => {
			const path = `flow.nodes[${index}]`;
			if (!isRecord(rawNode)) return rawNode;
			let node = stripKeys(rawNode, NODE_KEYS, path, repairs);
			node = {
				...node,
				title: clampText(node['title'], TITLE_MAX, `${path}.title`, repairs),
				...(node['detail'] === undefined ? {} : { detail: clampText(node['detail'], DETAIL_MAX, `${path}.detail`, repairs) }),
			};
			/*
			 * `planPath` 抄错（不合语法）就**摘掉**，不拒。
			 *
			 * 为什么摘掉是对的而不是"放过去"：没有 `planPath` 的框是纯讲解框——
			 * 设备跑到任何一步都不点亮它。**少点亮一个框不会骗人；点亮一个错的框才会。**
			 * （"这条路径在声明里到底存不存在"是下一层拿声明判的事，见 `findTeachingSpecIssues`。）
			 */
			const planPath = node['planPath'];
			const badSyntax = typeof planPath !== 'string' || !PLAN_PATH_PATTERN.test(planPath.trim());
			// 语法合法但**声明里没有这一步**——同样摘掉。这一条是用户那次踩的坑：
			// 模型给"等旋转走完"编了个 "2"，而任务只有一步（只有 "0"）。
			const notInPlan = !badSyntax && known !== null && !known.has((planPath as string).trim());
			if (planPath !== undefined && (badSyntax || notInPlan)) {
				const { planPath: _dropped, ...rest } = node;
				repairs.push({
					path: `${path}.planPath`,
					what: badSyntax
						? `路径 ${JSON.stringify(planPath)} 不合语法，摘掉这个框的联动（它变成纯讲解框）`
						: `路径 ${JSON.stringify(planPath)} 在这次任务里没有对应的步，摘掉这个框的联动（它变成纯讲解框）`,
				});
				node = rest;
			}
			return node;
		});
		const repairedEdges = edges.map((rawEdge, index) => {
			const path = `flow.edges[${index}]`;
			if (!isRecord(rawEdge)) return rawEdge;
			let edge = stripKeys(rawEdge, EDGE_KEYS, path, repairs);
			const arm = edge['arm'];
			if (arm !== undefined && arm !== 'then' && arm !== 'else') {
				const { arm: _dropped, ...rest } = edge;
				repairs.push({ path: `${path}.arm`, what: `臂 ${JSON.stringify(arm)} 不认识，摘掉（这条边按无臂处理）` });
				edge = rest;
			}
			return { ...edge, label: clampText(edge['label'], 48, `${path}.label`, repairs) };
		});
		spec = { ...spec, flow: { ...graph, nodes: repairedNodes, edges: repairedEdges } };
	}

	// ② 块树：语句块与值块各修一遍。
	if (Array.isArray(spec['blocks'])) {
		spec = {
			...spec,
			blocks: spec['blocks'].map((block, index) => repairBlock(block, `blocks[${index}]`, repairs) as TeachingBlock),
		};
	}

	// ③ 代码分段：行太长截断（版面考虑，不是判据）。
	if (Array.isArray(spec['codeSegments'])) {
		spec = {
			...spec,
			codeSegments: spec['codeSegments'].map((rawSegment, index) => {
				const path = `codeSegments[${index}]`;
				if (!isRecord(rawSegment)) return rawSegment;
				const segment = stripKeys(rawSegment, SEGMENT_KEYS, path, repairs);
				const lines = Array.isArray(segment['lines'])
					? segment['lines'].map((line, lineIndex) =>
							clampText(line, LINE_MAX, `${path}.lines[${lineIndex}]`, repairs),
						)
					: segment['lines'];
				return { ...segment, lines };
			}),
		};
	}

	return { value: spec, repairs };
};

/** 修完再判一遍：形状过不过，由契约说了算（修补层不自己下结论）。 */
export const reparsedAfterRepair = (
	raw: unknown,
	context: RepairContext = {},
): { readonly ok: true; readonly spec: unknown; readonly repairs: readonly SpecRepair[] } | null => {
	const { value, repairs } = repairTeachingSpec(raw, context);
	const parsed = teachingSpecSchema.safeParse(value);
	return parsed.success ? { ok: true, spec: parsed.data, repairs } : null;
};

export type { TeachingValueBlock };

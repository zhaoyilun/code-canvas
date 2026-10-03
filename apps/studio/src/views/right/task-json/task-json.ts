/**
 * 任务 JSON 视图的**数据**一侧：把声明按它出生时的格式还原成任务 JSON，并算出每一行「指向谁」。
 *
 * 两条规矩：
 *
 * 1. **还原归格式，这里不拼键。** 同一份声明在不同设备下还原出来的原文长得完全不一样
 *    （一期是 `steps` + 七个固定动作，RoboFrame 是一串 `plan` 里的技能调用），所以
 *    「声明 → 原文」只由 `findTaskFormat(formatRef).fromDeclaration` 给——这与写回时
 *    第二道闸用的**是同一个函数**。视图自己拼一份平行定义，迟早会跟写回通道对不上。
 *    本文件只做一件事：把那份 JSON 摊成一行行，并记住每一行的出处。
 * 2. **每一行都记下它指向哪一步。** 属于某个 step 的每一行都挂着那个节点的 id，参数行还挂一个
 *    「这个参数在实现里的第几步被用到」——那个下标是从**目录的实现树**里扫出来的
 *    （`implementation` 里哪条顶层语句引用了 `{kind:'param', name}`），不是猜的、不是写死的。
 *    界面据此复用 `store.select(nodeId)` 与 `store.selectStep(index)`，与既有联动同一套。
 *
 * 行是**自己生成的**（不是把 `JSON.stringify` 的结果切开来数），所以「这一行属于哪一步」
 * 是构造时就知道的事实，不靠事后正则去认缩进。格式各异（`steps` / `plan`、`action` / `skill`、
 * 参数平铺 / 收在 `params` 里），所以归属是**按数认的**：找那个条目数与声明里动作节点一一对应的
 * 顶层数组（见 `stepArrayKey`），而不是把某一种格式的键名写死在这里。
 */
import {
	findCapability,
	isJsonObject,
	type CapabilityCatalog,
	type CapabilitySpec,
	type ImplArgument,
	type ImplExpression,
	type ImplStatement,
	type JsonObject,
	type JsonValue,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { TASK_ACTION_NODE_TYPE, findTaskFormat, type TaskFormatRef } from '@codecanvas/task-import';
import { planStructureOf } from '../../shared/plan-structure';

/** 这一行在整份任务 JSON 里属于哪一段。 */
export type TaskJsonSection = 'meta' | 'step' | 'limits';

export interface TaskJsonLine {
	/** 行号，1 基（与代码面板同一口径）。 */
	readonly line: number;
	/** 完整文本，**含缩进**（缩进是 JSON 的一部分，不是样式）。 */
	readonly text: string;
	/** 缩进档数。 */
	readonly depth: number;
	readonly section: TaskJsonSection;
	/** 这一行属于哪个节点；任务级那几行是 null（点了没有「哪一步」可选）。 */
	readonly nodeId: string | null;
	/** 这一行属于第几个 step（1 基）；任务级那几行是 null。 */
	readonly stepOrdinal: number | null;
	/** 参数行才有：格式里的字段名（`linear`、`distance`……）；身份行与结构行是 null。 */
	readonly parameter: string | null;
	/** 该参数在实现里的顶层语句下标（目录里扫出来的）；扫不到或不是参数行就是 null。 */
	readonly implStepIndex: number | null;
}

export interface TaskJsonView {
	/** 还原时用的是哪个格式——标题上写的「这是哪种原文」就是它，不另外问一次。 */
	readonly formatRef: TaskFormatRef;
	/** 还原出来的任务 JSON。 */
	readonly task: JsonObject;
	readonly lines: readonly TaskJsonLine[];
	readonly stepCount: number;
}

/** 解析 `catalogRef` → 目录；找不到就 null（映射少一条，不编）。 */
export type CatalogResolver = (capabilityRef: string) => CapabilityCatalog | null;

/** 缩进一档 = 2 个空格（JSON 的惯例，与代码面板的 4 空格无关）。 */
const INDENT = '  ';

const pad = (depth: number): string => INDENT.repeat(depth);

/**
 * 声明 → 该格式的任务 JSON。**只转发**，不自己拼键。
 *
 * `formatRef` 必须显式给：猜一个格式就是把「这份声明出生时是什么样」换成「我现在想看什么」，
 * 而这两者恰恰是这个视图要区分开的东西。
 */
export const buildTaskJson = (declaration: WorkflowDeclaration, formatRef: TaskFormatRef): JsonObject =>
	findTaskFormat(formatRef).fromDeclaration(declaration);

/** 声明里承载任务的节点（顺序就是步骤顺序）。 */
export const actionNodes = (declaration: WorkflowDeclaration): readonly WorkflowNode[] =>
	declaration.nodes.filter((node) => node.type === TASK_ACTION_NODE_TYPE);

/** 这个节点的 `action` 指向哪个能力（技能计划里它装的是技能名，接缝是同一个键）。 */
export const capabilityRefOf = (node: WorkflowNode): string | null => {
	const action = node.parameters['action'];
	return typeof action === 'string' && action.length > 0 ? action : null;
};

/** 这个节点指向的能力在目录里的定义；查不到就是 null（映射少一条，不编）。 */
export const capabilityOf = (node: WorkflowNode, resolveCatalog: CatalogResolver): CapabilitySpec | null => {
	const capabilityRef = capabilityRefOf(node);
	if (capabilityRef === null) return null;
	const catalog = resolveCatalog(capabilityRef);
	if (catalog === null) return null;
	return findCapability(catalog, capabilityRef) ?? null;
};

// ---------------------------------------------------------------------------
// 参数 → 实现里的第几步
// ---------------------------------------------------------------------------

const argumentUsesParam = (argument: ImplArgument, name: string): boolean => {
	// 实参只有两种形状：字面量（含字符串数组）与表达式。数组里装的是字符串，不可能是引用。
	if (Array.isArray(argument)) return false;
	return typeof argument === 'object' ? expressionUsesParam(argument, name) : false;
};

const expressionUsesParam = (expression: ImplExpression, name: string): boolean => {
	switch (expression.kind) {
		case 'literal':
			return false;
		case 'param':
			return expression.name === name;
		case 'call':
			return Object.values(expression.arguments).some((argument) => argumentUsesParam(argument, name));
		case 'binary':
			return (
				expressionUsesParam(expression.left, name) || expressionUsesParam(expression.right, name)
			);
		case 'unary':
			return expressionUsesParam(expression.value, name);
	}
};

const statementUsesParam = (statement: ImplStatement, name: string): boolean => {
	switch (statement.kind) {
		case 'call':
			return Object.values(statement.arguments).some((argument) => argumentUsesParam(argument, name));
		case 'set':
			// `set speed = linear` 这种「先接住参数」也算用到了它——`move` 的实现就是这么写的。
			return statement.target === name || expressionUsesParam(statement.value, name);
		case 'if':
			return (
				expressionUsesParam(statement.condition, name) ||
				statement.then.some((child) => statementUsesParam(child, name)) ||
				(statement.else?.some((child) => statementUsesParam(child, name)) ?? false)
			);
		case 'delegate':
			// 委托步也是参数的去处：`target_name` 交给执行侧那个接口，箭头照样指向这一步。
			// 少了这一支，委托型技能的参数在映射表里会变成「哪儿都没用到」。
			return Object.values(statement.arguments).some((argument) => argumentUsesParam(argument, name));
	}
};

/**
 * 这个参数在实现里第一次出现在**第几条顶层语句**（0 基，与代码面板的 `stepIndex` 同一口径）。
 * 目录里没有这个能力、或实现里根本没用到这个参数，就是 null——那种情况不点亮任何一步。
 */
export const referencedStepIndex = (
	capability: CapabilitySpec | null,
	parameterName: string,
): number | null => {
	if (capability === null) return null;
	for (const [index, statement] of capability.implementation.entries()) {
		if (statementUsesParam(statement, parameterName)) return index;
	}
	return null;
};

// ---------------------------------------------------------------------------
// 摊成一行行：先建一棵带出处的树，再按 JSON 的逗号规矩吐出来
// ---------------------------------------------------------------------------

/** 渲染项的形状：标量一行，容器多行（下面还有子项）。 */
type ItemKind = 'scalar' | 'object' | 'array';

interface LineContext {
	readonly section: TaskJsonSection;
	readonly nodeId: string | null;
	readonly stepOrdinal: number | null;
}

/** 一行的出处：属于哪一段、哪个节点、哪个参数，以及参数在实现里的第几步。 */
interface LineOwner extends LineContext {
	readonly parameter: string | null;
	readonly implStepIndex: number | null;
}

interface RenderItem extends LineOwner {
	/** 这一项在对象里的键；数组元素没有键（null）。 */
	readonly key: string | null;
	readonly kind: ItemKind;
	readonly value: JsonValue;
	readonly children: readonly RenderItem[];
}

const kindOf = (value: JsonValue): ItemKind => {
	if (Array.isArray(value)) return 'array';
	return isJsonObject(value) ? 'object' : 'scalar';
};

const NO_OWNER: LineContext = { section: 'meta', nodeId: null, stepOrdinal: null };

/** 最外那对花括号的出处：不属于任何一段、也不属于任何一步。 */
const OUTSIDE: LineOwner = { ...NO_OWNER, parameter: null, implStepIndex: null };

/**
 * 格式里的**身份与判别字段**，不是参数：`id` / `step_id` 是步骤身份，`action` / `skill` 是能力引用，
 * `step` 是格式自己的判别键（技能计划里恒为 `'skill'`）。
 *
 * 参数名**不写死**：其余键一律当参数（技能计划把它们收在 `params` 里，那就取它的子键），
 * 而「这个参数在实现里第几步」仍然从目录扫（`referencedStepIndex`）——
 * 目录里没有的（比如 `timeoutSec`，它不是技能参数）就不点亮，不编一个下标出来。
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['id', 'step_id', 'action', 'step', 'skill']);

/**
 * 建一项。`childrenAreParams` 只在容器是「参数匣子」（技能计划的 `params`）时为 true——
 * 那时它的子键才是参数名；再深一层不继续当参数认（两种格式的参数都是一层标量）。
 */
const buildItem = (
	key: string | null,
	value: JsonValue,
	context: LineContext,
	parameter: string | null,
	implStepIndex: number | null,
	childrenAreParams: boolean,
	capability: CapabilitySpec | null,
): RenderItem => {
	const kind = kindOf(value);
	return {
		key,
		kind,
		value,
		...context,
		parameter,
		implStepIndex,
		children: buildChildren(value, context, childrenAreParams, capability),
	};
};

const buildChildren = (
	value: JsonValue,
	context: LineContext,
	childrenAreParams: boolean,
	capability: CapabilitySpec | null,
): readonly RenderItem[] => {
	if (Array.isArray(value)) {
		return value.map((child) => buildItem(null, child, context, null, null, false, capability));
	}
	if (isJsonObject(value)) {
		return Object.entries(value).map(([childKey, childValue]) =>
			buildItem(
				childKey,
				childValue,
				context,
				childrenAreParams ? childKey : null,
				childrenAreParams ? referencedStepIndex(capability, childKey) : null,
				false,
				capability,
			),
		);
	}
	return [];
};

/** 一个 step 的字段 → 渲染项。身份字段不带参数标记，容器取子键当参数名，其余键本身就是参数名。 */
const stepFields = (
	step: JsonObject,
	node: WorkflowNode | undefined,
	resolveCatalog: CatalogResolver,
	context: LineContext,
): readonly RenderItem[] => {
	const capability = node === undefined ? null : capabilityOf(node, resolveCatalog);
	return Object.entries(step).map(([key, value]) => {
		if (IDENTITY_KEYS.has(key)) return buildItem(key, value, context, null, null, false, capability);
		if (isJsonObject(value)) return buildItem(key, value, context, null, null, true, capability);
		return buildItem(key, value, context, key, referencedStepIndex(capability, key), false, capability);
	});
};

/**
 * 哪一项是「步骤数组」。
 *
 * 键名各格式不同（一期叫 `steps`，技能计划叫 `plan`），所以不写死：找那个**条目数与声明的
 * 顶层步骤一一对应**的顶层数组。对不上就不认——宁可不点亮任何一段，也不把别的东西错认成步骤。
 *
 * 「顶层步骤数」不是「动作节点数」：有分支时 `plan` 的一格是一个 `if`，两臂里的步骤嵌在
 * 那一格里面。早先这里数的是动作节点，于是带分支的计划一个都对不上、步数显示成 0 步。
 */
const stepArrayKey = (task: JsonObject, count: number): string | null => {
	for (const [key, value] of Object.entries(task)) {
		if (!Array.isArray(value)) continue;
		if (value.length === count && value.every((item) => isJsonObject(item))) return key;
	}
	return null;
};

/** 任务级安全上限那一段（一期协议有；技能计划没有，那就不会有这一段）。 */
const LIMITS_KEY = 'limits';

/** 声明 → 可渲染的行（带行号、缩进，以及每行指向谁）。 */
export const renderTaskJson = (
	declaration: WorkflowDeclaration,
	resolveCatalog: CatalogResolver,
	formatRef: TaskFormatRef,
): TaskJsonView => {
	const task = buildTaskJson(declaration, formatRef);
	// 顶层步骤的顺序与归属都由**声明图**推（`planStructureOf`），不是把 `nodes` 从头数一遍——
	// 有分支时后者会把臂里的步骤错认成顶层那几格。
	const nodes = planStructureOf(declaration).steps.map((step) => step.node);
	const stepsKey = stepArrayKey(task, nodes.length);

	const items: readonly RenderItem[] = Object.entries(task).map(([key, value]) => {
		const section: TaskJsonSection =
			key === stepsKey ? 'step' : key === LIMITS_KEY ? 'limits' : 'meta';
		const context: LineContext = { section, nodeId: null, stepOrdinal: null };

		// 步骤数组：第 n 项就属于声明里第 n 个动作节点——还原时就是这个顺序。
		if (key === stepsKey && Array.isArray(value)) {
			return {
				key,
				kind: 'array',
				value,
				...context,
				parameter: null,
				implStepIndex: null,
				children: value.map((step, index) => {
					const node = nodes[index];
					const owned: LineContext = {
						section,
						nodeId: node?.id ?? null,
						stepOrdinal: node === undefined ? null : index + 1,
					};
					const fields = isJsonObject(step) ? step : {};
					return {
						key: null,
						kind: 'object' as const,
						value: fields,
						...owned,
						parameter: null,
						implStepIndex: null,
						children: stepFields(fields, node, resolveCatalog, owned),
					};
				}),
			};
		}

		return buildItem(key, value, context, null, null, false, null);
	});

	const lines: TaskJsonLine[] = [];
	let counter = 0;

	const push = (text: string, depth: number, owner: LineOwner): void => {
		counter += 1;
		lines.push({
			line: counter,
			text,
			depth,
			section: owner.section,
			nodeId: owner.nodeId,
			stepOrdinal: owner.stepOrdinal,
			parameter: owner.parameter,
			implStepIndex: owner.implStepIndex,
		});
	};

	/**
	 * 一项 → 一行或多行。
	 *
	 * 缩进与逗号都在文本里：`last` 决定这一项后面跟不跟逗号，所以 JSON 的语法是这里生成的，
	 * 不靠事后拼接。`JSON.stringify` 只用来把值写出来（字符串加引号、数字原样）。
	 */
	const emit = (item: RenderItem, depth: number, last: boolean): void => {
		const label = item.key === null ? '' : `${JSON.stringify(item.key)}: `;
		const comma = last ? '' : ',';

		if (item.kind === 'scalar') {
			push(`${pad(depth)}${label}${JSON.stringify(item.value) ?? 'null'}${comma}`, depth, item);
			return;
		}

		const [open, close] = item.kind === 'object' ? ['{', '}'] : ['[', ']'];
		// 空的容器写成一行：`{}` / `[]` 比拆成两行更像 JSON 原文。
		if (item.children.length === 0) {
			push(`${pad(depth)}${label}${open}${close}${comma}`, depth, item);
			return;
		}

		push(`${pad(depth)}${label}${open}`, depth, item);
		item.children.forEach((child, index) => {
			emit(child, depth + 1, index === item.children.length - 1);
		});
		push(`${pad(depth)}${close}${comma}`, depth, item);
	};

	push('{', 0, OUTSIDE);
	items.forEach((item, index) => {
		emit(item, 1, index === items.length - 1);
	});
	push('}', 0, OUTSIDE);

	// 认不出步骤数组时就是 0：宁可不报数，也不报一个没画出来的数。
	return { formatRef, task, lines, stepCount: stepsKey === null ? 0 : nodes.length };
};

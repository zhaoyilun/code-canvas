/**
 * 任务 JSON 视图的**数据**一侧：从声明还原出一份可读的任务 JSON，并算出每一行「指向谁」。
 *
 * 两条规矩：
 *
 * 1. **只从声明还原，不猜原始输入。** spec §1.2 把节点的 `parameters` 定为**不透明载荷**，
 *    而导入器（`@codecanvas/task-import`）往里放的就是那个原始 step
 *    （`{step_id, action, ...}`）。所以这里把 `parameters` 摊回 step——`step_id` 还原成协议里的
 *    `id`——再把 `meta` 里的 `task_id` / `description` / `limits` 拼回任务级字段。
 *    这与编辑写回通道（`state/document.ts` 的 `declarationToTask`）是同一套还原口径：
 *    两边不一致的话，「面板上看到的」和「写回时验的」就是两份不同的东西。
 * 2. **每一行都记下它指向哪一步。** step 里的每一行都挂着那个节点的 id，参数行还挂一个
 *    「这个参数在实现里的第几步被用到」——那个下标是从**目录的实现树**里扫出来的
 *    （`implementation` 里哪条顶层语句引用了 `{kind:'param', name}`），不是猜的、不是写死的。
 *    界面据此复用 `store.select(nodeId)` 与 `store.selectStep(index)`，与既有联动同一套。
 *
 * 行是**自己生成的**（不是把 `JSON.stringify` 的结果切开来数），所以「这一行属于哪一步」
 * 是构造时就知道的事实，不靠事后正则去认缩进。
 */
import {
	canonicalizeJson,
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
import { TASK_ACTION_NODE_TYPE } from '@codecanvas/task-import';

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
	/** 参数行才有：协议字段名（`linear`、`distance`……）；`id` / `action` 与结构行是 null。 */
	readonly parameter: string | null;
	/** 该参数在实现里的顶层语句下标（目录里扫出来的）；扫不到或不是参数行就是 null。 */
	readonly implStepIndex: number | null;
}

export interface TaskJsonView {
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
 * 一个节点 → 一个 step。
 *
 * `step_id` 是节点侧的语义身份，还原成协议里那个 `id`，并放在第一个键上
 * （spec §1.1 的例子就是这么写的，`id` 在前比压在末尾好读）。`undefined` 的键丢掉——
 * 它不可表示，写进 JSON 就是假的。
 */
export const stepFromNode = (node: WorkflowNode): JsonObject => {
	const parameters = node.parameters;
	const step: JsonObject = {};
	const stepId = parameters['step_id'];
	if (stepId !== undefined) step['id'] = stepId;
	for (const [key, value] of Object.entries(parameters)) {
		if (key === 'step_id') continue;
		const canonical = canonicalizeJson(value);
		if (canonical === undefined) continue;
		step[key] = canonical;
	}
	return step;
};

/**
 * 声明 → 任务 JSON（任务级字段 + steps + limits）。
 *
 * 键序按协议读：`schema_version`、`task_id`、`description`、`steps`、`limits`。
 */
export const buildTaskJson = (declaration: WorkflowDeclaration): JsonObject => {
	const meta = declaration.meta;
	const task: JsonObject = {};
	task['schema_version'] = meta['schema_version'] ?? '1.0';
	task['task_id'] = meta['task_id'] ?? declaration.id;
	const description = meta['description'];
	if (description !== undefined) task['description'] = description;
	task['steps'] = actionNodes(declaration).map((node) => stepFromNode(node));
	const limits = meta['limits'];
	task['limits'] = limits === undefined ? {} : limits;
	return task;
};

/** 声明里承载任务的节点（顺序就是步骤顺序）。 */
export const actionNodes = (declaration: WorkflowDeclaration): readonly WorkflowNode[] =>
	declaration.nodes.filter((node) => node.type === TASK_ACTION_NODE_TYPE);

/** 这个节点的 `action` 指向哪个能力。 */
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
// 渲染成一行行
// ---------------------------------------------------------------------------

const renderValue = (value: JsonValue): string => JSON.stringify(value) ?? 'null';

interface StepEntry {
	readonly node: WorkflowNode;
	readonly step: JsonObject;
	readonly ordinal: number;
}

/** 声明 → 可渲染的行（带行号、缩进，以及每行指向谁）。 */
export const renderTaskJson = (
	declaration: WorkflowDeclaration,
	resolveCatalog: CatalogResolver,
): TaskJsonView => {
	const task = buildTaskJson(declaration);
	const entries: StepEntry[] = actionNodes(declaration).map((node, index) => ({
		node,
		step: stepFromNode(node),
		ordinal: index + 1,
	}));

	const lines: TaskJsonLine[] = [];
	let counter = 0;

	const push = (
		text: string,
		depth: number,
		rest: Partial<Omit<TaskJsonLine, 'line' | 'text' | 'depth'>> = {},
	): void => {
		counter += 1;
		lines.push({
			line: counter,
			text,
			depth,
			section: rest.section ?? 'meta',
			nodeId: rest.nodeId ?? null,
			stepOrdinal: rest.stepOrdinal ?? null,
			parameter: rest.parameter ?? null,
			implStepIndex: rest.implStepIndex ?? null,
		});
	};

	push('{', 0);

	// 任务级字段：`steps` / `limits` 之外的那几个（schema_version / task_id / description）。
	for (const key of ['schema_version', 'task_id', 'description']) {
		const value = task[key];
		if (value === undefined) continue;
		push(`${pad(1)}${JSON.stringify(key)}: ${renderValue(value)},`, 1, { section: 'meta' });
	}

	// steps：一个 step 一段，段内每一行都挂着那个节点的 id。
	if (entries.length === 0) {
		push(`${pad(1)}"steps": [],`, 1, { section: 'step' });
	} else {
		push(`${pad(1)}"steps": [`, 1, { section: 'step' });
		entries.forEach((entry, position) => {
			const lastStep = position === entries.length - 1;
			const capability = capabilityOf(entry.node, resolveCatalog);
			const owned = {
				section: 'step' as const,
				nodeId: entry.node.id,
				stepOrdinal: entry.ordinal,
			};

			push(`${pad(2)}{`, 2, owned);
			const fields = Object.entries(entry.step);
			fields.forEach(([field, value], fieldPosition) => {
				const lastField = fieldPosition === fields.length - 1;
				const isParameter = field !== 'id' && field !== 'action';
				push(`${pad(3)}${JSON.stringify(field)}: ${renderValue(value)}${lastField ? '' : ','}`, 3, {
					...owned,
					parameter: isParameter ? field : null,
					implStepIndex: isParameter ? referencedStepIndex(capability, field) : null,
				});
			});
			push(`${pad(2)}}${lastStep ? '' : ','}`, 2, owned);
		});
		push(`${pad(1)}],`, 1, { section: 'step' });
	}

	// limits：任务级安全上限。整个任务一个数，不属于任何一步。
	const limits = isJsonObject(task['limits']) ? task['limits'] : {};
	const limitEntries = Object.entries(limits);
	if (limitEntries.length === 0) {
		push(`${pad(1)}"limits": {}`, 1, { section: 'limits' });
	} else {
		push(`${pad(1)}"limits": {`, 1, { section: 'limits' });
		limitEntries.forEach(([name, value], position) => {
			const lastLimit = position === limitEntries.length - 1;
			push(`${pad(2)}${JSON.stringify(name)}: ${renderValue(value)}${lastLimit ? '' : ','}`, 2, {
				section: 'limits',
			});
		});
		push(`${pad(1)}}`, 1, { section: 'limits' });
	}

	push('}', 0);

	return { task, lines, stepCount: entries.length };
};

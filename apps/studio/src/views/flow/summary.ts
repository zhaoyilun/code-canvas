/**
 * 节点卡片上那几行参数摘要（spec §4.1：字段定义只有校验器一个来源）。
 *
 * 这里不写任何参数表：字段名、顺序、单位、范围全部来自 `describeActionFields(action)`，
 * 值来自节点自己的 `parameters`。声明里多出来的字段（协议不认识的）照样显示，由协议校验器决定它们合不合法。
 */
import {
	ALLOWED_ACTIONS,
	describeActionFields,
	LIMIT_NAMES,
	canonicalJsonString,
	isJsonObject,
	type Diagnostic,
	type JsonObject,
	type JsonValue,
	type NumericLimitName,
	type ProtocolFieldSummary,
	type TaskAction,
	type WorkflowNode,
} from '@codecanvas/contracts';

/** 任务限值：与字段名无关的上界（`linear → max_linear` 之类）从声明的 meta 里取，不在视图里重写一遍。 */
export type NodeLimits = Partial<Record<NumericLimitName, number>>;

export interface ParameterSummary {
	/** 参数名（协议字段名）。 */
	readonly name: string;
	/** 取值的显示形态：数字保留原精度，数组逗号连接，缺省用 `—`。 */
	readonly value: string;
	/** 取值范围，例如 `≤ 0.3` / `1–6` / `> 0`；协议没给约束就是空串。 */
	readonly constraint: string;
	readonly unit: string;
	/** 校验器给这个人话说明。 */
	readonly description: string;
	/** 声明里没给这个字段的取值（可选字段会这样）。 */
	readonly missing: boolean;
}

/** 动作名是不是七种之一。判据只在协议那边，这里只是把它的枚举读回来，不另立一份。 */
const isAction = (value: JsonValue | undefined): value is TaskAction =>
	typeof value === 'string' && (ALLOWED_ACTIONS as readonly string[]).includes(value);

/** 显示值：数字原样（不四舍五入，摘要与声明逐字一致），数组按顺序列出，结构走稳定键序 JSON。 */
const displayValue = (value: JsonValue | undefined): string => {
	if (value === undefined) return '—';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map((item) => displayValue(item)).join(', ');
	return canonicalJsonString(value);
};

/** 该参数的约束显示。限值类字段（`linear` 这类）的上界只能从声明的 limits 来，取不到就不显示。 */
const constraintOf = (field: ProtocolFieldSummary, limits: NodeLimits): string => {
	if (field.kind === 'sensors') return '仅 /scan0、/scan1';
	if (field.limit !== undefined) {
		const bound = limits[field.limit];
		return bound === undefined ? '' : `${field.abs === true ? '|值| ' : ''}≤ ${bound}`;
	}
	const parts: string[] = [];
	if (field.min !== undefined && field.max !== undefined) parts.push(`${field.min}–${field.max}`);
	else if (field.max !== undefined) parts.push(`≤ ${field.max}`);
	else if (field.min !== undefined) parts.push(`≥ ${field.min}`);
	if (field.exclusiveMin !== undefined) parts.push(`> ${field.exclusiveMin}`);
	if (field.integer === true) parts.push('整数');
	return parts.join('，');
};

/** 卡片上要显示的那几行：先按校验器的字段顺序，再补上声明里多出来的字段。 */
export const summarizeNodeParameters = (
	parameters: JsonObject,
	action: TaskAction | null,
	limits: NodeLimits = {},
): readonly ParameterSummary[] => {
	const rows: ParameterSummary[] = [];
	const covered = new Set<string>();

	if (action !== null) {
		for (const field of describeActionFields(action)) {
			covered.add(field.name);
			const value = parameters[field.name];
			rows.push({
				name: field.name,
				value: displayValue(value),
				constraint: constraintOf(field, limits),
				unit: field.unit ?? '',
				description: field.description,
				missing: value === undefined,
			});
		}
	}

	for (const [name, value] of Object.entries(parameters)) {
		// step_id / action 已经在卡头上了，不再占一行。
		if (covered.has(name) || name === 'step_id' || name === 'action') continue;
		rows.push({
			name,
			value: displayValue(value),
			constraint: '',
			unit: '',
			description: '声明里多出来的字段',
			missing: false,
		});
	}

	return rows;
};

/** 从节点参数里读动作名。读到不认识的值就是 `null`——不认识不等于没有，调用方据此显示原样。 */
export const nodeAction = (node: WorkflowNode): TaskAction | null => {
	const action = node.parameters.action;
	return isAction(action) ? action : null;
};

/** 动作名的显示形态：不认识就照出原值，不假装它是七种动作之一。 */
export const actionLabel = (node: WorkflowNode): string => {
	const action = node.parameters.action;
	return isAction(action) ? action : displayValue(action);
};

/** 节点上的语义身份（`parameters.step_id`，spec §1.2 保留它是为了映射）。 */
export const nodeStepId = (node: WorkflowNode): string | null => {
	const stepId = node.parameters.step_id;
	return typeof stepId === 'string' ? stepId : null;
};

const isLimitName = (value: string): value is NumericLimitName => (LIMIT_NAMES as readonly string[]).includes(value);

/**
 * 从声明 meta 里取限值。取不到就返回空表——摘要里的上界跟着一起消失，
 * 而不是显示一个视图自己编的数字。
 */
export const declarationLimits = (meta: JsonObject | undefined): NodeLimits => {
	const raw = meta?.limits;
	if (!isJsonObject(raw)) return {};
	const limits: NodeLimits = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'number' && isLimitName(key)) limits[key] = value;
	}
	return limits;
};

/**
 * 挂在这个节点上的诊断。
 *
 * 判据只有一条：诊断的 `ref` / `path` 指向这个节点或它那一步。
 * `ref` 可能是节点 id（声明层）或步骤 id（任务层）。
 * `path` 有两种写法都真实存在：schema 层用点号（`nodes.2.id`），语义层用下标（`nodes[1].id`）——两种都得认。
 * 别的诊断不往卡片上挂——挂错地方比不挂更误导。
 */
export const nodeDiagnostics = (
	diagnostics: readonly Diagnostic[],
	node: WorkflowNode,
	index: number,
): readonly Diagnostic[] => {
	const stepId = nodeStepId(node);
	return diagnostics.filter((diagnostic) => {
		if (diagnostic.ref !== undefined) {
			if (diagnostic.ref === node.id) return true;
			if (stepId !== null && diagnostic.ref === stepId) return true;
		}
		const path = diagnostic.path;
		if (path === undefined) return false;
		return path.startsWith(`nodes[${index}]`) || path === `nodes.${index}` || path.startsWith(`nodes.${index}.`);
	});
};

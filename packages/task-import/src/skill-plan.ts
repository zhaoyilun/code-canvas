/**
 * 技能计划 → workflow 声明。与 `convert.ts` 平级：**一台设备一套任务格式**，
 * 但两条路汇进同一份声明，后面三个视图一点都不知道任务原来是哪种格式。
 *
 * 转换只做三件事：每个 plan 步变一个节点、按顺序串成一条链、把 robot/description 收进 meta。
 * 校验归 `@codecanvas/contracts` 的 `validateSkillPlan`（判据是**目录**），这里绝不重复判断。
 *
 * 一个 `skill` 步 → 一个 `task.action` 节点：
 *
 * ```text
 * { step: 'skill', skill: 'wave_hello', params: { … } }
 *   →  parameters: { action: 'wave_hello', …params }
 * ```
 *
 * `action` 这个键是三个视图的接缝（`findCapability` 认它），技能的参数就平铺在它旁边——
 * 于是「点开一个模块看它的实现」这条路，与一期任务那条完全一样，不用多一套机制。
 * `timeoutSec` 与 `onFailure` 也平铺在这儿：两个都**不是技能参数**（目录里没这两栏），
 * 按原名进 `parameters`，逆映射原样收回——它们只在任务 JSON 视图与流程卡上露面，来回一趟不丢。
 *
 * 一个 `if` 步 → 一个 `task.branch` 节点，**三格出边**（位置就是语义，空的那一格也要占着位置）：
 *
 * ```text
 * connections[分支节点] = { main: [ [then 的头], [else 的头], [这一层后面那一步的头] ] }
 *                              main[0]      main[1]            main[2]
 * ```
 *
 * - 条件原样进 `parameters.condition`（键名照 `SkillPlan` 里写），不翻译成别的形状；
 * - 两条臂各自串成一条链，**链尾不再接回主干**：这一版不做汇合点，臂走完就完了；
 * - `main[2]` 是「`if` 执行完了接着往下走」的那一步，**接在分支节点自己身上**，
 *   与走了哪一臂无关——结构化语句本来就是这个语义。所以它**不是回汇**：
 *   回汇是两条边收进同一个节点，这里两条臂仍然各自收尾，只是分支节点多了一条往后的边。
 *
 * 一个 `wait` 步 → 一个 `task.wait` 节点，**只有一格出边**（与技能步一样是单格）：
 *
 * ```text
 * { step: 'wait', seconds: 2 }
 *   →  parameters: { seconds: 2 }
 * ```
 *
 * 为什么不开三格：三格是**分支专用**的（位置就是 then / else / 后续）。等待没有臂，
 * 给它三格等于让下游以为「这一步能分叉」，视图与逆映射都得跟着猜哪一格才算数。
 * 秒数原样进参数，还原时原样收回——`seconds` 是这一步的全部内容，不翻译成别的键。
 *
 * 一个 `primitive` 步 → 一个 `task.primitive` 节点，**一格出边**（与技能步一样）：
 *
 * ```text
 * { step: 'primitive', primitive: 'open_gripper', params: { … } }
 *   →  parameters: { primitive: 'open_gripper', …params }
 * ```
 *
 * 参数平铺的做法与技能步**同一套**，只是指名的那一栏从 `action` 换成 `primitive`。
 * **为什么不用 `action`**：`action` 是「能力」的接缝（`findCapability` 认它，视图据此去目录里
 * 找一个**有实现可看**的能力）——原语不是能力，它没有 `implementation` 可展开。
 * 借用那个键，三个视图就会拿原语名去 `catalog.capabilities` 里查，然后报「查不到这个能力」，
 * 而事实是「这一步本来就不经过任何能力」。键名分开，判据才会分开。
 */
import {
	computeWorkflowDigest,
	createUlidIdFactory,
	DiagnosticCollector,
	SKILL_PLAN_SCHEMA_VERSION,
	WORKFLOW_FORMAT_VERSION,
	validateSkillPlan,
	type BranchStep,
	type CapabilityCatalog,
	type ConnectionTarget,
	type Diagnostic,
	type JsonObject,
	type PrimitiveStep,
	type SkillPlan,
	type SkillPlanStep,
	type SkillStep,
	type StableIdFactory,
	type WaitStep,
	type WorkflowConnections,
	type WorkflowDeclaration,
	type WorkflowDeclarationDraft,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { NODE_HORIZONTAL_SPACING, TASK_ACTION_NODE_TYPE, TASK_ACTION_NODE_TYPE_VERSION } from './convert';

/**
 * 分支节点的类型。与 `TASK_ACTION_NODE_TYPE` 并列——两者是同一层里的两种节点，不是两套协议。
 * 视图靠它认「这是一步判断」，`parameters.condition` 里装的就是 `SkillPlan` 里那份条件。
 */
export const TASK_BRANCH_NODE_TYPE = 'task.branch';
export const TASK_BRANCH_NODE_TYPE_VERSION = 1;

/**
 * 等待步的节点类型。与上面两个并列——同一层里的第三种节点，不是另一套协议。
 * 它没有 `action`（不是技能），也没有 `condition`（不是判断）：参数只有 `seconds`。
 */
export const TASK_WAIT_NODE_TYPE = 'task.wait';
export const TASK_WAIT_NODE_TYPE_VERSION = 1;

/**
 * 原语步的节点类型。与上面三个并列——同一层里的第四种节点，不是另一套协议。
 * 它**没有 `action`**（原语不是能力，见文件头）：指名的那一栏是 `primitive`，参数照样平铺在它旁边。
 */
export const TASK_PRIMITIVE_NODE_TYPE = 'task.primitive';
export const TASK_PRIMITIVE_NODE_TYPE_VERSION = 1;

/**
 * 等待步的显示名：`3. 等待 2 秒`。
 *
 * 一句话写在这儿而不是散在三个视图里：卡片头、积木标题、节点名说的是同一件事，
 * 各写一遍就会各漂各的。数字就是声明里那一个（不换算成分钟、不四舍五入）。
 */
const waitLabel = (seconds: number): string => `等待 ${String(seconds)} 秒`;

/** 臂的纵向偏移。x 严格按创建序递增（节点因此不会重叠），y 只用来分开主干与两条臂。 */
const NODE_VERTICAL_SPACING = 140;

export interface ImportSkillPlanOptions {
	/** 设备报上来的目录。技能与参数都照它判。 */
	readonly catalog: CapabilityCatalog;
	/** 缺省用 ULID 工厂；测试与重放注入确定性工厂。 */
	readonly idFactory?: StableIdFactory;
	/** 计划要送给哪台机器人；给了就与计划里的 `robot` 对照。 */
	readonly expectedRobot?: string;
}

export type SkillPlanImportResult =
	| { readonly ok: true; readonly declaration: WorkflowDeclaration; readonly diagnostics: readonly Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** 分支节点建好之后手上要留着的东西：两条臂的链头（臂为空就是 `undefined`）。 */
interface BuiltBranch {
	readonly then: string | undefined;
	readonly else: string | undefined;
}

interface BuiltStep {
	readonly id: string;
	/** 只有分支步有——普通步骤没有臂。 */
	readonly arms?: BuiltBranch;
}

export const buildDeclarationFromPlan = (
	plan: SkillPlan,
	catalog: CapabilityCatalog,
	idFactory: StableIdFactory,
): WorkflowDeclaration => {
	const nodes: WorkflowNode[] = [];
	const connections: WorkflowConnections = {};
	/** 创建序。显示名的编号与 x 坐标都用它，于是名字天然唯一、节点天然不重叠。 */
	let created = 0;

	const takePosition = (y: number) => {
		const order = created;
		created += 1;
		return { order, position: { x: order * NODE_HORIZONTAL_SPACING, y } };
	};

	const skillNode = (step: SkillStep, y: number): WorkflowNode => {
		const { order, position } = takePosition(y);
		const parameters: JsonObject = { action: step.skill, ...(step.params ?? {}) };
		// 超时**不**是技能参数（目录里没这一栏），所以它带着原名进节点参数：
		// 技能自己声明的参数在三个视图里渲染，它只在任务 JSON 视图里露面，来回一趟不丢。
		if (step.timeoutSec !== undefined) parameters['timeoutSec'] = step.timeoutSec;
		// 失败处置跟超时同一个待遇：**不是技能参数**（目录里没这一栏），按原名进节点参数。
		// 视图（流程卡上的「失败也往下走」）也从这一个键读，不另立一张字段表。
		if (step.onFailure !== undefined) parameters['onFailure'] = step.onFailure;
		return {
			id: idFactory.nodeId(),
			// 显示名用目录里的中文标签——「打招呼」比 `wave_hello` 更像这个界面上该有的东西。
			name: `${String(order + 1)}. ${
				catalog.capabilities.find((item) => item.capabilityRef === step.skill)?.label ?? step.skill
			}`,
			type: TASK_ACTION_NODE_TYPE,
			typeVersion: TASK_ACTION_NODE_TYPE_VERSION,
			parameters,
			position,
			disabled: false,
		};
	};

	const branchNode = (step: BranchStep, y: number): WorkflowNode => {
		const { order, position } = takePosition(y);
		return {
			id: idFactory.nodeId(),
			name: `${String(order + 1)}. 分支`,
			type: TASK_BRANCH_NODE_TYPE,
			typeVersion: TASK_BRANCH_NODE_TYPE_VERSION,
			// 条件**原样**进参数（键名 `condition` 照 `SkillPlan` 里写）：还原那一步因此不需要第二套语义，
			// 视图认的也是同一个键。
			parameters: {
				condition: { field: step.condition.field, op: step.condition.op, value: step.condition.value },
			},
			position,
			disabled: false,
		};
	};

	/** 一格出边：那一格没有东西（臂为空 / 没有后续步骤）就给空数组——位置本身是语义，不许省略。 */
	const port = (headId: string | undefined): ConnectionTarget[] =>
		headId === undefined ? [] : [{ node: headId, input: 0 }];

	/**
	 * 一个 `wait` 步 → 一个节点，参数只有 `seconds`（原样）。
	 * 它的出边由下面那条通用规则给（普通步骤一格），这里不开三格——见文件头。
	 */
	const waitNode = (step: WaitStep, y: number): WorkflowNode => {
		const { order, position } = takePosition(y);
		return {
			id: idFactory.nodeId(),
			name: `${String(order + 1)}. ${waitLabel(step.seconds)}`,
			type: TASK_WAIT_NODE_TYPE,
			typeVersion: TASK_WAIT_NODE_TYPE_VERSION,
			parameters: { seconds: step.seconds },
			position,
			disabled: false,
		};
	};

	/**
	 * 一个 `primitive` 步 → 一个节点，指名的那一栏是 `primitive`、参数平铺在它旁边
	 * （与技能步同一套做法，只是不借 `action` 那个「能力」的接缝——见文件头）。
	 * 它的出边由下面那条通用规则给（普通步骤一格）。
	 */
	const primitiveNode = (step: PrimitiveStep, y: number): WorkflowNode => {
		const { order, position } = takePosition(y);
		const parameters: JsonObject = { primitive: step.primitive, ...(step.params ?? {}) };
		// 超时与失败处置跟技能步同一个待遇：**不是原语参数**（目录里没这两栏），按原名进节点参数。
		if (step.timeoutSec !== undefined) parameters['timeoutSec'] = step.timeoutSec;
		if (step.onFailure !== undefined) parameters['onFailure'] = step.onFailure;
		return {
			id: idFactory.nodeId(),
			// 显示名用目录里那个原语的标签（「张开夹爪」），查不到就照出原名——不编一个。
			name: `${String(order + 1)}. ${
				catalog.primitives.find((item) => item.primitiveRef === step.primitive)?.label ?? step.primitive
			}`,
			type: TASK_PRIMITIVE_NODE_TYPE,
			typeVersion: TASK_PRIMITIVE_NODE_TYPE_VERSION,
			parameters,
			position,
			disabled: false,
		};
	};

	/** 把一串步串成一条链，返回链头的节点 id（空链给 `undefined`）。嵌套的 `if` 在这里递归下去。 */
	const buildList = (steps: readonly SkillPlanStep[], y: number): string | undefined => {
		const built: BuiltStep[] = [];
		for (const step of steps) {
			if (step.step === 'skill') {
				const node = skillNode(step, y);
				nodes.push(node);
				built.push({ id: node.id });
				continue;
			}
			if (step.step === 'wait') {
				const node = waitNode(step, y);
				nodes.push(node);
				built.push({ id: node.id });
				continue;
			}
			if (step.step === 'primitive') {
				const node = primitiveNode(step, y);
				nodes.push(node);
				built.push({ id: node.id });
				continue;
			}
			const node = branchNode(step, y);
			nodes.push(node);
			// 两条臂各自是一条链，纵向错开。臂里再放 `if` 就在这两行里递归下去。
			built.push({
				id: node.id,
				arms: {
					then: buildList(step.then, y - NODE_VERTICAL_SPACING),
					else: step.else === undefined ? undefined : buildList(step.else, y + NODE_VERTICAL_SPACING),
				},
			});
		}

		// 连线留到最后一步做：分支的第三格要填「这一层里跟在它后面的那一步」，
		// 而那一步得先建出来才知道 id。节点本身的声明顺序仍是「分支 → 它的两条臂 → 后续」。
		built.forEach((item, index) => {
			const continuation = port(built[index + 1]?.id);
			if (item.arms === undefined) {
				// 普通步骤只有一格：下一步。链尾没有出边。
				if (continuation.length > 0) connections[item.id] = { main: [continuation] };
				return;
			}
			connections[item.id] = { main: [port(item.arms.then), port(item.arms.else), continuation] };
		});

		return built[0]?.id;
	};

	buildList(plan.plan, 0);

	const meta: JsonObject = {
		schemaVersion: SKILL_PLAN_SCHEMA_VERSION,
		robot: plan.robot,
		...(plan.description === undefined ? {} : { description: plan.description }),
	};

	const draft: WorkflowDeclarationDraft = {
		formatVersion: WORKFLOW_FORMAT_VERSION,
		id: idFactory.workflowId(),
		name: plan.description?.trim() ?? plan.robot,
		nodes,
		connections,
		meta,
	};

	return { ...draft, digest: computeWorkflowDigest(draft) };
};

export const importSkillPlan = (
	input: unknown,
	options: ImportSkillPlanOptions,
): SkillPlanImportResult => {
	const validation = validateSkillPlan(input, {
		catalog: options.catalog,
		...(options.expectedRobot === undefined ? {} : { expectedRobot: options.expectedRobot }),
	});
	if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };

	const declaration = buildDeclarationFromPlan(
		validation.plan,
		options.catalog,
		options.idFactory ?? createUlidIdFactory(),
	);
	return { ok: true, declaration, diagnostics: validation.diagnostics };
};

export const importSkillPlanJson = (text: string, options: ImportSkillPlanOptions): SkillPlanImportResult => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const collector = new DiagnosticCollector();
		collector.error({
			code: 'skill_plan_import.json_parse_error',
			message: '计划 JSON 解析不了',
			details: { reason: error instanceof Error ? error.message : String(error) },
		});
		return { ok: false, diagnostics: collector.diagnostics };
	}
	return importSkillPlan(parsed, options);
};

/**
 * **半成品**：模型还在吐字的时候，从累积文本里"能解析出多少算多少"，做成一层**预览**。
 *
 * 这一层与真相的关系，只有一句话：**它永远不进 `state/document.ts` 的 `declaration`**。
 * 理由是这份东西的性质：模型吐到一半的 JSON 必然是残缺的、按定义还没校验过的，
 * 而真相只接收过了两道闸的定稿（见 `state/document.ts`）。所以这里给出的东西：
 *
 * - 只用来渲染流程画布上的**幽灵卡**（虚线描边 + 「未校验」字样），定稿一到就整块换掉；
 * - 状态放在 `provisional-declaration.ts` 里，与 `shell/device-run.ts` 那些「运行时状态」同一量级，
 *   **不是文档真相**；
 * - 造声明用的是 `@codecanvas/task-import` 已经导出的 `buildDeclarationFromPlan`——它不做校验，
 *   正是这里要的。所以这一层**不调用** `validateSkillPlan`，也不调用 `loadTaskJson`：
 *   半成品不校验（校验一次就把它判死，而它本来就还没写完），也永远不进真相。
 *   `provisional.test.ts` 里有一条直接把这句话钉死。
 *
 * ## 容错的边界（逐条说清，因为边界就是这个函数的全部内容）
 *
 * 模型吐技能计划时，`plan` 数组是**一个个对象**堆出来的，而每个对象是原子地闭合的
 * （`}` 之前那一段迟早会补齐，所以"括号闭合了"就等于"这个步骤写完了"）。于是：
 *
 * - **只认已经闭合的顶层步骤对象**：从 `"plan"` 后面那个 `[` 开始数括号，一个顶层对象的
 *   `{` 配到它自己的 `}` 就算一步。闭合前的尾段**原样丢着，不猜、不补**。
 * - 字符串里的括号不算括号（`"params": {"note": "}{"}` 这种要读对），转义也要认
 *   （`"note": "他说 \"好\""` 里的 `\"` 不能当成字符串结束）。
 * - 括号还没闭合、或者断在一个字符串中间，都只影响**那一步**：前面的步骤照样出。
 * - `"plan"` 这个键还没出现（模型还在写 `schemaVersion` / `robot`）→ 零步，但**全文仍然给**
 *   （界面那行原始文本读的是累积文本，不是解析结果）。
 * - `robot` 读不出来就给空串：`buildDeclarationFromPlan` 拿它当标题，空串只是"还不知道标题"，
 *   不是错误——这一步没有任何东西可以校验，也就不该在这里报错。
 * - 步骤里字段残缺（`{"step":"skill"}` 没有 skill 名）、技能名不在目录里，**照常显示**：
 *   它是幽灵态，本来就还没校验；目录里查不到只会让它顶着标识符出场（`rows.ts` 那条
 *   "协议不认识就去目录里问，问不到就照出原名"的路），不崩。
 * - 一段半成品里有**多个**顶层对象时（模型偶尔重写一版），逐个解析：能成几个算几个，
 *   解析不了的那一个只跳过它自己，后面的照试——一步坏掉不该把整份预览清空。
 *
 * ## 为什么 id 是算出来的，不是随机的
 *
 * 幽灵卡每来一段文本就重建一次。id 要是 ULID，每次重建所有节点的 id 都变，
 * 于是 DOM 每段都整棵重挂（选中态、滚动位置、连线锚点全跟着跳）。所以这里用一个
 * **按内容定**的工厂：同一步在同一份计划里每次解析都拿到同一个 id。
 * 这些 id 与真相里的 id 没有任何关系（真相的 id 由导入那条路的 ULID 工厂给）——
 * 它只是给这一层预览用的一把稳定钥匙。
 */
import { SKILL_PLAN_STEP_KINDS } from '@codecanvas/contracts';
import type {
	CapabilityCatalog,
	SkillPlan,
	SkillPlanStep,
	StableIdFactory,
	WorkflowDeclaration,
} from '@codecanvas/contracts';
import { buildDeclarationFromPlan, type TaskFormatRef } from '@codecanvas/task-import';

/** 模型吐计划时，那三个我们关心的键。`plan` 是唯一不可缺的（它是步骤本身）。 */
const PLAN_KEY = 'plan';
const ROBOT_KEY = 'robot';
const DESCRIPTION_KEY = 'description';
const SCHEMA_VERSION_KEY = 'schemaVersion';

/**
 * 一份半成品的诊断码。**只有一条**，因为它想说的只有一件事：这份东西还没校验过。
 *
 * 界面不靠它显示（幽灵态有自己的静态标记），它是给机器判断用的——"这份预览是从一段
 * 未校验的原文来的"。码进诊断，人话在 `PROVISIONAL_LABEL` 里。
 */
export const PROVISIONAL_REASON_CODE = 'provisional.unverified';

/** 幽灵态上那句可见的字。定稿一到就没了——它不是状态提示，是标注。 */
export const PROVISIONAL_LABEL = '未校验';

/**
 * 一份半成品声明 + 它是怎么来的。
 *
 * `declaration` 这个类型与真相**同型**（好让流程画布那一套渲染原封不动地用），
 * 但它的身份完全不同：它没有过任何一道闸，也没有出生格式——类型相同不等于地位相同，
 * 所以它只在 `provisionalDeclaration` 这个运行时的 ref 里活着，从不交给 `doc`。
 */
export interface ProvisionalSkillPlan {
	/** 从累积文本里抽出来的那半份计划（只有已经闭合的步骤）。 */
	readonly plan: SkillPlan;
	/** 由上面那半份计划编出来的声明——**没有过闸，不是真相**。 */
	readonly declaration: WorkflowDeclaration;
	/** 解出了几步（顶层步骤的个数）。界面拿它说「已经长出来几张幽灵卡」。 */
	readonly stepCount: number;
	/** 累积文本里 `plan` 那个键出现了没有。没出现时 `stepCount` 是 0，但原文照样有。 */
	readonly sawPlanKey: boolean;
}

/** 从累积文本里读一个字符串字段的值；读不出来给空串（不猜）。 */
const stringField = (text: string, key: string): string => {
	const keyIndex = text.indexOf(`"${key}"`);
	if (keyIndex < 0) return '';
	const colon = text.indexOf(':', keyIndex + key.length + 2);
	if (colon < 0) return '';
	let index = colon + 1;
	while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
	if (text.charAt(index) !== '"') return '';
	index += 1;

	let value = '';
	while (index < text.length) {
		const char = text.charAt(index);
		if (char === '\\') {
			const escaped = text.charAt(index + 1);
			if (escaped === '') break; // 断在转义符后面：这一段还没写完
			value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
			index += 2;
			continue;
		}
		if (char === '"') return value;
		value += char;
		index += 1;
	}
	// 断在字符串中间：已经读到的那部分留着——它是个名字，不是结构。
	return value;
};

/**
 * 数一个数字字段的值；读不出来给 `fallback`。
 * 只认 `123` 这种整数字面量：`schemaVersion` 是整数，小数与别的写法都不该在这里解释。
 */
const numberField = (text: string, key: string, fallback: number): number => {
	const keyIndex = text.indexOf(`"${key}"`);
	if (keyIndex < 0) return fallback;
	const colon = text.indexOf(':', keyIndex + key.length + 2);
	if (colon < 0) return fallback;
	const match = /^\s*(\d+)/.exec(text.slice(colon + 1));
	return match === null ? fallback : Number(match[1]);
};

/**
 * 从累积文本里把**已经闭合的顶层步骤对象**逐个切出来。
 *
 * 判据就是括号闭合（见文件头）。`from` 是 `plan` 的那个 `[` 的下标；`[` 还没出现时给 -1，
 * 那时一个对象都切不出来（数组都还没开头）。
 */
const closedStepObjects = (text: string, from: number): string[] => {
	if (from < 0) return [];
	const found: string[] = [];
	/** 0 = 在数组里、还没进对象；≥1 = 在某个对象里面（含它自己的嵌套数组与对象）。 */
	let depth = 0;
	/** 已经进过数组了没有。判"数组闭合"要看它，不能看第一个 `]`——模型会重吐一版计划。 */
	let entered = false;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let index = from + 1; index < text.length; index += 1) {
		const char = text.charAt(index);
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === '{') {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (char === '}') {
			if (depth > 0) depth -= 1;
			if (depth === 0 && start >= 0) {
				found.push(text.slice(start, index + 1));
				start = -1;
			}
			continue;
		}
		// 数组开始/结束只在**对象外面**（`depth === 0`）才有意义：对象里的 `[` 是它自己的数组。
		if (char === '[' && depth === 0) {
			entered = true;
			continue;
		}
		// 数组闭合：这个 plan 到底了。之后再冒出来的对象属于模型重吐的另一版，
		// **不算这一步的步骤**（宁可少画一张，也不把两版拼成一份没人写过的计划）。
		if (char === ']' && depth === 0 && entered) break;
	}

	return found;
};

/** `plan` 那个 `[` 的下标；没出现给 -1。 */
const planArrayStart = (text: string): number => {
	const keyIndex = text.indexOf(`"${PLAN_KEY}"`);
	if (keyIndex < 0) return -1;
	const colon = text.indexOf(':', keyIndex + PLAN_KEY.length + 2);
	if (colon < 0) return -1;
	return text.indexOf('[', colon + 1);
};

/**
 * 累积文本 → 一份稳定的 id 工厂。
 *
 * 同一份计划每次都从 0 开始编号，于是同样的步骤每次都拿到同样的 id（见文件头）。
 * 前缀与真相那边一致（`wf_` / `nd_`），因为这份声明要喂给同一套视图。
 */
const stableIds = (): StableIdFactory => {
	let workflow = 0;
	let node = 0;
	return {
		workflowId: () => {
			workflow += 1;
			return `wf_provisional_${String(workflow)}`;
		},
		nodeId: () => {
			node += 1;
			return `nd_provisional_${String(node)}`;
		},
		// 积木那一侧不参与流式（它要查目录才画得出实现），所以这条路上不会有块 id。
		// 工厂的契约要求有这个成员，就给一个同样稳定的号，不给随机值。
		blockId: () => 'bl_provisional_0',
	};
};

/** 一个对象是不是"能当这一步用"：`step` 这一栏认得出来（别的栏残缺也不拦）。 */
const isStepShaped = (value: unknown): boolean => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const kind = (value as { step?: unknown }).step;
	return typeof kind === 'string' && (SKILL_PLAN_STEP_KINDS as readonly string[]).includes(kind);
};

/** 逐个把闭合的对象解析出来；解析不了的那一个跳过，不影响别的。 */
const parseSteps = (raw: readonly string[]): SkillPlanStep[] => {
	const steps: SkillPlanStep[] = [];
	for (const text of raw) {
		try {
			const value: unknown = JSON.parse(text);
			/*
			 * 判据只有"认得 `step` 这一栏"——**不是校验**（技能名、参数类型、取值范围一个都不看，
			 * 那是校验器的事，而这一层不校验）。
			 *
			 * 为什么连这一步都要有：`buildDeclarationFromPlan` 会按 `step` 分下去建节点，
			 * 而分支那一路直接读 `condition.field`。模型吐到一半时 `{}` 或 `{"step":"if"}`
			 * 都是**合法 JSON**（括号闭合了、字段还没来），拿给那个函数会当场抛。
			 * 这里挡掉的是"还不知道这一步是什么"，不是"这一步不合法"——后者照画（幽灵态本来就没校验）。
			 * 被挡掉的那一步不是丢了：原文那一行照旧在，等它写全了下一次解析就会长出来。
			 */
			if (isStepShaped(value)) steps.push(value as SkillPlanStep);
		} catch {
			// 括号闭合了但内容不是合法 JSON（模型写了半个转义、多了个逗号）：跳过这一步，继续。
		}
	}
	return steps;
};

/**
 * 造半成品声明时用的那份目录：**只用来查中文标签**，所以它一份能力都不列。
 *
 * 为什么可以用空目录：`buildDeclarationFromPlan` 从目录里只取两样东西——技能/原语的显示名
 * （查不到就照出原名，正是幽灵态该有的样子）。技能名对不对、参数类型对不对，全是校验的事，
 * 而这一层**不校验**。给一份没有能力的目录，等于把"查不到"这件事说清楚：幽灵卡上的名字
 * 就是模型写的那个名字，不是我们替它认下来的名字。
 *
 * 它不走 `capabilityCatalogSchema`（那份 schema 要求至少一个能力）——这里要的就是一份
 * "什么都不知道"的目录，拿真 schema 拼一份假的，反倒会被读成"这台设备只有这些能力"。
 */
const LABELS_UNKNOWN: CapabilityCatalog = {
	catalogRef: 'provisional_preview',
	displayName: '未校验的预览',
	revisionRef: 'provisional',
	primitives: [],
	capabilities: [],
};

/**
 * 累积文本 → 半成品。**纯函数**：同样一段文本永远给同样一份东西（含 id）。
 *
 * 返回 `null` 只有一种情形：格式不是技能计划。别的格式（一期协议）这一步还没有半成品解析——
 * 那一路的"逐个步骤"要另立一份判据，不该在这里拿技能计划那把尺子量（见交付报告里的说明）。
 * 界面拿到 `null` 就不摆幽灵态，原始文本那行照样有。
 */
export const parseProvisionalSkillPlan = (
	formatRef: TaskFormatRef,
	text: string,
): ProvisionalSkillPlan | null => {
	if (formatRef !== 'skill_plan') return null;

	const start = planArrayStart(text);
	const steps = parseSteps(closedStepObjects(text, start));
	const robot = stringField(text, ROBOT_KEY);
	const description = stringField(text, DESCRIPTION_KEY);
	const plan: SkillPlan = {
		schemaVersion: numberField(text, SCHEMA_VERSION_KEY, 1),
		robot,
		...(description === '' ? {} : { description }),
		plan: steps,
	};

	/*
	 * 造声明：`buildDeclarationFromPlan` 是导入那条路上**同一个**函数（它不做校验）。
	 * 我们不自己拼节点、拼连线——那样迟早与导入侧分叉，幽灵卡与定稿卡就会长得不一样。
	 */
	const declaration = buildDeclarationFromPlan(plan, LABELS_UNKNOWN, stableIds());

	return { plan, declaration, stepCount: steps.length, sawPlanKey: start >= 0 };
};

/**
 * 「一句话 → 任务 JSON」这一步的业务层：**提示词按设备格式切** + 一次通用 JSON 通话。
 *
 * 为什么要按格式切：两种格式的**词汇表不一样**。一期协议是七个写死的动作，每个动作的必填参数
 * 与取值范围都得交代；技能计划是一串技能调用，技能名与参数由设备目录给、随时能增删。
 * 一份提示词盖两种格式，模型只会照写死的那份词汇表编——编出来的技能计划里全是目录里没有的名字。
 *
 * 所以这一层认的是**格式**（`formatRef`）与**目录**（`catalog`），不认哪台设备：
 * - `phase1_task`：`SYSTEM_PROMPT`（逐字来自参考实现，见它上面的说明）；
 * - `skill_plan`：`skillPlanSystemPrompt(catalog)`，**由目录现生成**——不许手写技能清单。
 *
 * 请求体里也照实带上 `deviceRef` / `formatRef`：设备组一眼看得出这一句话是按哪把尺子编的。
 *
 * 与 LLM 通话的那部分（地址、请求体、剥围栏、重试）在 `llm-json.ts` 里，是**通用**的——
 * 紧接着的第二次调用（任务 JSON → 能力实现）复用同一个函数，这里不重复实现一遍。
 *
 * 两条路走的是同一个函数、同一个请求体：
 *
 * - 默认地址是 `/llm`（相对路径）。dev server 把 `/llm/*` 反代到 LLM 服务，**在服务端注入
 *   Authorization**——API key 从不进浏览器。请求打到 `<地址>/chat/completions`。
 * - 联调时把地址改成设备组的基地址即可。设备组读请求体里的 `catalogRef` / `instruction`
 *   两个字段就行，OpenAI 那几个字段忽略掉；响应可以直接给任务 JSON 本身（没有信封也认）。
 *
 * 校验**不在这里**：拿到文本后由调用方通过 `accept` 交给 `state/document.ts` 的
 * `loadTaskJson`——那是唯一一条导入路（结构 + 任务语义两道闸都在它后面）。
 */
import {
	SKILL_PLAN_MAX_WAIT_SECONDS,
	SKILL_PLAN_SCHEMA_VERSION,
	type CapabilityCatalog,
	type Diagnostic,
	type JsonObject,
} from '@codecanvas/contracts';
import type { TaskFormatRef } from '@codecanvas/task-import';
import {
	GENERATION_ATTEMPTS,
	RETRY_DELAY_MS,
	type GenerationMessage,
	type JsonGenerationFailureKind,
	generateJson,
} from './llm-json';
import { generateJsonStream } from './llm-stream';

/**
 * 一期任务规划器的系统提示词。
 *
 * ⚠ **逐字来自 `docs/reference/llm_client.py` 的 `SYSTEM_PROMPT`**，一个字都不许改写：
 * 七种动作、每种动作的必填参数与取值范围、`sensors` 的取值、默认 `limits`，全在里面写死了。
 * 那边改一处，这里跟着改一处（`task-generation.test.ts` 里有一条测试直接读那个文件对账）。
 */
export const SYSTEM_PROMPT = `你是RoboFrame一期机器人任务规划器。只输出合法JSON，不要输出Markdown和解释。
必须包含schema_version="1.0"、task_id、description、steps数组、limits对象。
steps中的action只能是move、turn、stop、stop_if_obstacle、get_status、arm_joint、arm6_joints。
move必须包含id、linear、angular、duration；turn必须包含id、angular、duration；
stop和get_status必须包含id；stop_if_obstacle必须包含id、sensors数组和distance。
arm_joint用于单关节控制，必须包含id、joint_id(1~6)、joint(0~180)、time(100~10000毫秒)。
arm6_joints用于六关节控制，必须包含id、joint1到joint6(均为0~180)、time(100~10000毫秒)。
sensors只能使用/scan0或/scan1。默认limits为max_linear=0.3、max_angular=1.2、
max_duration=30.0、require_confirmation=true。`;

/**
 * 技能计划格式的系统提示词：**由目录生成**。
 *
 * 为什么不能手写一份技能清单（哪怕它现在看着没错）：技能是设备报上来的、能随时增删的，
 * 手写清单等于把提示词变成第二份目录——目录一改，模型照旧清单编，而校验器拿的是真目录，
 * 于是每一条都被拒。参数名与类型同理，照 `catalog.capabilities[].parameters` 如实列出来。
 * **原语清单也照目录现生成**（`catalog.primitives`），同样不许手写。
 */
export const skillPlanSystemPrompt = (catalog: CapabilityCatalog): string => {
	const robot = catalog.robotName;
	const parameters = (declared: readonly { name: string; type: string; unit?: string; required?: boolean }[]): string =>
		declared.length === 0
			? '没有参数'
			: declared
					.map((parameter) => {
						// 单位与必填也来自目录（上游 JSON Schema）：模型不该猜「米还是度」。
						const unit = parameter.unit === undefined ? '' : `/${parameter.unit}`;
						const must = parameter.required === true ? '，必填' : '';
						return `${parameter.name}(${parameter.type}${unit}${must})`;
					})
					.join('、');
	const skills = catalog.capabilities
		.map((capability) => `- ${capability.capabilityRef}（${capability.label}）：${parameters(capability.parameters)}`)
		.join('\n');
	const primitives = catalog.primitives
		.map((primitive) => `- ${primitive.primitiveRef}（${primitive.label}）：${parameters(primitive.parameters)}`)
		.join('\n');

	return `你是${catalog.displayName}的技能规划器。只输出合法JSON，不要输出Markdown和解释。
必须包含schemaVersion=${String(SKILL_PLAN_SCHEMA_VERSION)}、robot、plan数组。
${
	robot === undefined
		? 'robot必须是这台机器人自己认的名字。'
		: `robot必须是"${robot}"，别的名字一律不行。`
}
plan的每一步要么是一次技能调用，要么是直接叫一个原语，要么是一次条件分叉，要么是一次等待。
技能调用形如{"step":"skill","skill":"技能名","params":{…}}，skill只能从下面这份技能清单里选；
这一步要限时就加"timeoutSec"（秒，正数），它跟"params"平级，不要放进params里。
这一步失败之后怎么办，看"onFailure"，它也只能跟"params"平级，取值只有"stop"和"continue"。
**缺省是"stop"**：这一步没成，整条计划就停在这里（这是默认，也是安全立场——机器不会在失败之后自己接着按计划动）。
**只在「这一步失败也有下一步可走」时才写"continue"**：那时计划继续往下走，并且「上一步成没成」记成没成，
所以后面可以跟一个 condition 为 {"field":"last.success","op":"==","value":false} 的分叉去补救。
没想清楚就别写这一栏——不写就是停。
"onFailure"只能写在技能调用与直接叫原语那两种步上：等待与分叉不许带它。
params里的参数名与类型只能用下面列出的那些；标着「没有参数」的技能不要给params。
直接叫一个原语形如{"step":"primitive","primitive":"原语名","params":{…}}，原语只能从下面那份原语清单里选，
它的"params"、"timeoutSec"、"onFailure"与技能调用那一步完全同待遇（一样会成会败，也照样参与「上一步成没成」）。
**什么时候用它**：上面那份技能清单里**已经有干这件事的技能时，一律用技能**——
技能带着它自己的守卫与恢复策略（那台设备上验证过的做法），直接用原语等于把这些绕过去；
只有**没有技能包装的原子动作**（清单里有、技能清单里没有对应的那一个，比如张开夹爪 / 闭合夹爪这种）
才写成 primitive 步。不要为了少写一层就编一个假技能，也不要放着现成的技能不用去拆成原语。
条件分叉形如{"step":"if","condition":{…},"then":[…],"else":[…]}
——condition 只能是 {"field":"last.success","op":"=="或"!=","value":true或false}，
说的是「上一步成功了没有」；then 里至少一步，else 可以不给，给了就不能空；
两臂里放的是同样的步骤，所以分叉还能再套分叉（最多八层）。
只在「下一步做什么要看上一步成没成」时才用分叉；顺着的动作就直接排下去，不要硬套。
等待形如{"step":"wait","seconds":2}——seconds 是正数（秒），最多 ${String(SKILL_PLAN_MAX_WAIT_SECONDS)}（十分钟），超了直接报错。
它只是让计划在这里停一下：不改动「上一步成没成」（后面的分叉看的仍是它前面那一步的结果），也不动机械臂。
只在两步之间真的需要停一下时才用（比如夹住了、等它稳定两秒、再移动）——技能自己带的时长管不了这种间隔，顺着的动作就直接排下去。
description可选，给这个任务起一个中文名。
可用技能：
${skills}
可用原语（只在技能清单里没有对应技能时才用）：
${primitives}`;
};

/** 这一次通话的对话：system 定规矩（缺省是一期那份），user 就是用户那句话（原文，不改写）。 */
export const taskMessages = (
	instruction: string,
	systemPrompt: string = SYSTEM_PROMPT,
): readonly GenerationMessage[] => [
	{ role: 'system', content: systemPrompt },
	{ role: 'user', content: instruction },
];

/** 按格式挑提示词：词汇表不一样，规矩就不一样。 */
const systemPromptFor = (formatRef: TaskFormatRef, catalog: CapabilityCatalog): string =>
	formatRef === 'skill_plan' ? skillPlanSystemPrompt(catalog) : SYSTEM_PROMPT;

export interface TaskGenerationOptions {
	/** 基地址。请求打到 `<基地址>/chat/completions`。 */
	readonly endpoint: string;
	/** 这一句话发给哪台设备。进请求体的 `deviceRef`。 */
	readonly deviceRef: string;
	/** 这台的格式——挑提示词、并在请求体里说明这一句话是按哪把尺子编的。 */
	readonly formatRef: TaskFormatRef;
	/** 这台的目录。技能计划那份提示词的词汇表就从它现生成。 */
	readonly catalog: CapabilityCatalog;
	readonly instruction: string;
	/**
	 * 「这份文本能不能用」。调用方传 `doc.loadTaskJson`——校验只有那一条路。
	 * 返回 false 就再试一次（模型偶尔漏个字段，重试一次的收益是实打实的）。
	 */
	readonly accept: (text: string) => boolean;
	readonly model?: string;
	readonly attempts?: number;
	/** 测试用：换掉 fetch 与等待。 */
	readonly fetchImpl?: typeof fetch;
	readonly wait?: (ms: number) => Promise<void>;
	/** 每次真的要发请求之前报一下（界面拿它写「第 N 次」）。 */
	readonly onAttempt?: (attempt: number, total: number) => void;
}

export type TaskGenerationResult =
	| { readonly ok: true; readonly text: string; readonly attempts: number }
	| {
			readonly ok: false;
			readonly kind: JsonGenerationFailureKind;
			readonly message: string;
			/** 最后拿到的那份原文（传输层就没拿到过就是 null）——落进兜底框，让人看得见。 */
			readonly text: string | null;
			readonly attempts: number;
	  };

/**
 * 生成一次任务 JSON。
 *
 * 设备组接口要的 `catalogRef` / `instruction` 作为**额外字段**塞进同一个请求体：
 * LLM 服务看 `messages`，设备组看那几个字段，多出来的字段两边都忽略——于是「联调时改地址」
 * 真的只是改一个地址，不需要换一套代码。
 */
export async function generateTask(options: TaskGenerationOptions): Promise<TaskGenerationResult> {
	const extras = requestExtras(options);

	const result = await generateJson({
		messages: taskMessages(options.instruction, systemPromptFor(options.formatRef, options.catalog)),
		endpoint: options.endpoint,
		extras,
		...(options.model === undefined ? {} : { model: options.model }),
		attempts: options.attempts ?? GENERATION_ATTEMPTS,
		accept: (_value, text) => options.accept(text),
		...(options.onAttempt === undefined ? {} : { onAttempt: options.onAttempt }),
		...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
		...(options.wait === undefined ? {} : { wait: options.wait }),
	});

	if (result.ok) return { ok: true, text: result.text, attempts: result.attempts };
	return {
		ok: false,
		kind: result.kind,
		message: result.error,
		text: result.text,
		attempts: result.attempts,
	};
}

export interface StreamingTaskGenerationOptions extends Omit<TaskGenerationOptions, 'fetchImpl' | 'wait'> {
	/**
	 * 每收到一段就报一次（参数是**累积到此刻的全文**）。
	 * 界面拿它做两件事：入口带那行原始文本、以及重算半成品。
	 */
	readonly onDelta?: (accumulated: string) => void;
	/** 中止：新一轮生成开始、组件卸载时把在途的断掉（`TaskInputBand` 的 `runId` 那套机制）。 */
	readonly signal?: AbortSignal;
	/** 测试用：换掉 fetch 与空闲计时。 */
	readonly fetchImpl?: typeof fetch;
	readonly idleTimeoutMs?: number;
	/** 两次尝试之间的等待；缺省与 `generateJson` 同一个数（`RETRY_DELAY_MS`）。 */
	readonly wait?: (ms: number) => Promise<void>;
}

/**
 * 流式版：**同一个请求体、同一份提示词**，只是边说边给。
 *
 * 与非流式版的差别只有两处，都是刻意的：
 *
 * 1. 文本是**边收边报**的（`onDelta`），所以界面在生成途中就有东西可看——这是这一版存在的理由；
 * 2. 判据（`accept`）只能在**一段说完了**之后再看（半截 JSON 当然过不了），于是重试的口径变成
 *    「这一整段流完了、文本过不了判据 → 再流一次」。半成品解析不在这里：它是**预览**，
 *    与判据无关，由界面自己从 `onDelta` 的文本算（见 `provisional.ts`）。
 *
 * 中止走 `signal`：调用方一断，`fetch` 那层就断，`ok: false, kind: 'aborted'` 收场——
 * 不重试、也不算失败（那一次生成已经作废了）。
 */
export async function generateTaskStream(options: StreamingTaskGenerationOptions): Promise<TaskGenerationResult> {
	const extras = requestExtras(options);
	const messages = taskMessages(options.instruction, systemPromptFor(options.formatRef, options.catalog));
	const attempts = Math.max(1, options.attempts ?? GENERATION_ATTEMPTS);
	const wait = options.wait ?? defaultWait;

	let lastText: string | null = null;
	let failure: { kind: JsonGenerationFailureKind; message: string } = {
		kind: 'transport',
		message: '没有发起请求',
	};

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		options.onAttempt?.(attempt, attempts);
		const result = await generateJsonStream({
			messages,
			endpoint: options.endpoint,
			extras,
			...(options.model === undefined ? {} : { model: options.model }),
			...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
			...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
			...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
		});

		if (result.ok) {
			lastText = result.text;
			// 拿回来了，判据在调用方手里——与非流式那条路同一个口径（`loadTaskJson` 是唯一那条路）。
			if (options.accept(result.text)) return { ok: true, text: result.text, attempts: attempt };
			failure = { kind: 'rejected', message: '模型给的 JSON 没通过调用方的判据' };
		} else {
			// 调用方自己中止的（新一轮生成 / 组件卸载）：那一次生成已经作废。
			// 这里给 `transport` 只是**形状上的归属**——结果一交出去就被 `runId` 那道检查丢掉，
			// 界面既不出诊断也不改真相（`TaskInputBand` 里逐个失败分支都先看 `runId`）。
			if (result.kind === 'aborted') {
				return { ok: false, kind: 'transport', message: result.error, text: result.text, attempts: attempt };
			}
			// **只更新到「拿到过多东西」**：后一次尝试连不上时 `text` 是 null，用 null 盖掉
			// 前一次已经收到的部分，兜底框就空了——而"拿到过什么就让人看得见"这一条不该被重试抹掉。
			if (result.text !== null) lastText = result.text;
			// 卡住与流读一半断掉都是传输层：调用方看到的都是「这个地址没给全那份 JSON」。
			failure = {
				kind: result.kind === 'response' ? 'response' : 'transport',
				message: result.error,
			};
		}

		if (attempt < attempts) await wait(RETRY_DELAY_MS);
	}

	return { ok: false, kind: failure.kind, message: failure.message, text: lastText, attempts };
}

/** 两次尝试之间的等待（照 `llm-json.ts` 的 `RETRY_DELAY_MS`）。 */
const defaultWait = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * 请求体里那些**不是 OpenAI 字段**的额外字段（设备组接口看它们）。
 *
 * 流式与非流式两条路各要一份，所以只在这里拼一次：两条路带的东西必须一样，
 * 各写一遍迟早有一边漏一个字段，而那是联调时最难发现的一类偏差。
 */
function requestExtras(options: TaskGenerationOptions): JsonObject {
	const extras: JsonObject = {
		// 从目录里推，不另开一个入参：设备与它的目录必须对得上，多一个入口就多一次对不上的机会。
		catalogRef: options.catalog.catalogRef,
		deviceRef: options.deviceRef,
		formatRef: options.formatRef,
		instruction: options.instruction,
	};
	// 技能计划要写明编给哪台机器人（上游 `robot_config` 的 `robot.name`）。
	// 一期协议没有这一栏，也不编一个空字符串糊上去。
	if (options.formatRef === 'skill_plan' && options.catalog.robotName !== undefined) {
		extras['robot'] = options.catalog.robotName;
	}
	return extras;
}

/** 传输 / 响应层失败用的诊断码（协议那几条由 `loadTaskJson` 给，码也是它的）。 */
export const GENERATE_FAILED_CODE = 'task_input.generate_failed';

/** 供界面直接摆出来的那条诊断。 */
export const generationDiagnostic = (message: string, ref: string): Diagnostic => ({
	code: GENERATE_FAILED_CODE,
	severity: 'error',
	message: `生成接口没回任务 JSON：${message}`,
	ref,
});

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
	SKILL_PLAN_SCHEMA_VERSION,
	type CapabilityCatalog,
	type Diagnostic,
	type JsonObject,
} from '@codecanvas/contracts';
import type { TaskFormatRef } from '@codecanvas/task-import';
import {
	GENERATION_ATTEMPTS,
	type GenerationMessage,
	type JsonGenerationFailureKind,
	generateJson,
} from './llm-json';

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
 */
export const skillPlanSystemPrompt = (catalog: CapabilityCatalog): string => {
	const robot = catalog.robotName;
	const skills = catalog.capabilities
		.map((capability) => {
			const parameters =
				capability.parameters.length === 0
					? '没有参数'
					: capability.parameters
							.map((parameter) => {
								// 单位与必填也来自目录（上游 JSON Schema）：模型不该猜「米还是度」。
								const unit = parameter.unit === undefined ? '' : `/${parameter.unit}`;
								const must = parameter.required === true ? '，必填' : '';
								return `${parameter.name}(${parameter.type}${unit}${must})`;
							})
							.join('、');
			return `- ${capability.capabilityRef}（${capability.label}）：${parameters}`;
		})
		.join('\n');

	return `你是${catalog.displayName}的技能规划器。只输出合法JSON，不要输出Markdown和解释。
必须包含schemaVersion=${String(SKILL_PLAN_SCHEMA_VERSION)}、robot、plan数组。
${
	robot === undefined
		? 'robot必须是这台机器人自己认的名字。'
		: `robot必须是"${robot}"，别的名字一律不行。`
}
plan的每一步要么是一次技能调用，要么是一次条件分叉。
技能调用形如{"step":"skill","skill":"技能名","params":{…}}，skill只能从下面这份清单里选；
这一步要限时就加"timeoutSec"（秒，正数），它跟"params"平级，不要放进params里。
params里的参数名与类型只能用下面列出的那些；标着「没有参数」的技能不要给params。
条件分叉形如{"step":"if","condition":{…},"then":[…],"else":[…]}
——condition 只能是 {"field":"last.success","op":"=="或"!=","value":true或false}，
说的是「上一步成功了没有」；then 里至少一步，else 可以不给，给了就不能空；
两臂里放的是同样的步骤，所以分叉还能再套分叉（最多八层）。
只在「下一步做什么要看上一步成没成」时才用分叉；顺着的动作就直接排下去，不要硬套。
description可选，给这个任务起一个中文名。
可用技能：
${skills}`;
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

/** 传输 / 响应层失败用的诊断码（协议那几条由 `loadTaskJson` 给，码也是它的）。 */
export const GENERATE_FAILED_CODE = 'task_input.generate_failed';

/** 供界面直接摆出来的那条诊断。 */
export const generationDiagnostic = (message: string, ref: string): Diagnostic => ({
	code: GENERATE_FAILED_CODE,
	severity: 'error',
	message: `生成接口没回任务 JSON：${message}`,
	ref,
});

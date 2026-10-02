/**
 * 「一句话 → 任务 JSON」这一步的业务层：一份写死的系统提示词 + 一次通用 JSON 通话。
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
 * `loadTaskJson`——那是唯一一条导入路（结构 + 任务协议两道闸都在它后面）。
 */
import type { Diagnostic, JsonObject } from '@codecanvas/contracts';
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

/** 这一次通话的对话：system 定规矩，user 就是用户那句话（原文，不改写）。 */
export const taskMessages = (instruction: string): readonly GenerationMessage[] => [
	{ role: 'system', content: SYSTEM_PROMPT },
	{ role: 'user', content: instruction },
];

export interface TaskGenerationOptions {
	/** 基地址。请求打到 `<基地址>/chat/completions`。 */
	readonly endpoint: string;
	readonly catalogRef: string;
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
 * LLM 服务看 `messages`，设备组看那两个字段，多出来的字段两边都忽略——于是「联调时改地址」
 * 真的只是改一个地址，不需要换一套代码。
 */
export async function generateTask(options: TaskGenerationOptions): Promise<TaskGenerationResult> {
	const extras: JsonObject = {
		catalogRef: options.catalogRef,
		instruction: options.instruction,
	};

	const result = await generateJson({
		messages: taskMessages(options.instruction),
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

/**
 * **第二次模型调用**：任务 JSON + 目录 → 教学规格。
 *
 * 为什么是第二次调用而不是渲染层推导：屏幕上那三样（流程图 / 积木 / 教学代码）要讲的是
 * 「机器为了做这件事一步步在干什么」。从目录推的那套只能推出**目录里有的**——
 * `inspect_scene` 在目录里就是一条 `move_to_named_pose(pose_name="observe_table")`，
 * 推出来是一块积木、一行代码，讲不出「视觉定位 → 规划 → 靠近 → 合爪 → 抬起 → 验证」这种
 * 执行侧内部的管线。那正是教学要讲的东西，而它**只存在于模型的讲解里**。
 *
 * 走的是现成的那条路：`llm-json.ts` + `llm-stream.ts`（同一个 `/llm` 反代，key 不进浏览器）。
 * 与非流式那条路共用请求体，只多两处（都在这里说清楚）：
 *
 * 1. `max_tokens` 调大（4096）：`llm-json.ts` 的 512 是给「一句话 → 一份任务 JSON」定的，
 *    教学规格比它长得多（流程图 + 块树 + 一整段代码）。这个字段是**覆写**（`extras` 在后面展开），
 *    不是新开一份请求体——`requestBody` 那一套（temperature / response_format /
 *    reasoning_effort）原样不变。
 * 2. 流式读，`onDelta` 把**累积到此刻的全文**报给界面：长文生成时界面要有东西可看
 *    （「模型正在写… N 字」）。节拍铺开用的是**解析后的规格**，不是这段半成品文本
 *    ——半截 JSON 解析不出东西来，硬解析等于把「正在写」装成「已经画出来了」。
 *
 * 失败一律不抛、也不静默：三类失败（传输 / 形状 / 判据）各带自己的说法回去，
 * 界面照实说「模型没画出来，因为……」，并把已经收到的原文交回去。
 */
import {
	parseTeachingSpec,
	type CapabilityCatalog,
	type Diagnostic,
	type JsonObject,
	type TeachingSpec,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';
import { GENERATION_ATTEMPTS, RETRY_DELAY_MS, type GenerationMessage } from './llm-json';
import { generateJsonStream } from './llm-stream';
import { TEACHING_SYSTEM_PROMPT, teachingMaterialOf } from './teaching-prompt';

/**
 * 教学规格那一次说话的长度上限。
 *
 * 512（`llm-json.ts` 的 `MAX_TOKENS`）装不下：一棵块树 + 一张流程图 + 一段带注释的代码，
 * 实测在一千多 token。4096 是留了两倍余量的一档——再大就只是给模型机会啰嗦。
 */
export const TEACHING_MAX_TOKENS = 4096;

/** 这一次通话的对话：system 定规矩与形状，user 给材料（任务 JSON + 目录序列化）。 */
export const teachingMessages = (material: string): readonly GenerationMessage[] => [
	{ role: 'system', content: TEACHING_SYSTEM_PROMPT },
	{ role: 'user', content: material },
];

export type TeachingFailureKind = 'transport' | 'response' | 'rejected' | 'aborted';

export interface TeachingGenerationOptions {
	/** 基地址。请求打到 `<基地址>/chat/completions`（与非流式那条路同一个约定）。 */
	readonly endpoint: string;
	/** 这次的声明（材料里的任务 JSON 就是它）。 */
	readonly declaration: WorkflowDeclaration;
	/** 声明对应的目录（材料里的六块都从它来）。 */
	readonly catalog: CapabilityCatalog;
	/** 设备与格式的 ref，进请求体（设备组接口看它们）。 */
	readonly deviceRef: string;
	readonly formatRef: string;
	/**
	 * 任务 JSON 的原文（模型吐出来的那份，或导入那条路的规范化 JSON）。
	 * 交给材料当「这次的任务 JSON」，而不是在这里重新序列化一遍声明。
	 */
	readonly declarationText: string;
	/**
	 * 每一步的执行路径 → 那一步（`planPathsOf` 的结果）。
	 *
	 * 两处要用它，问的是同一件事：材料里那张「照这张表抄 planPath」的表，
	 * 以及解析时的对账（「这条路径指得到声明里的一步吗」）。
	 * 不给的话材料里那一块说「列不出来」，**解析也只判形状**——生成那条路一定要给。
	 */
	readonly planPaths?: ReadonlyMap<string, WorkflowNode>;
	/**
	 * 执行路径 → 那一步（`nodeAtPlanPath`）。对账那一层用它，与设备报的路径同一份口径。
	 * 与 `planPaths` 一起给：一张表列出所有路径，一个函数判一条路径对不对。
	 */
	readonly nodeAtPlanPath?: (declaration: WorkflowDeclaration, path: string) => WorkflowNode | null;
	readonly model?: string;
	readonly attempts?: number;
	/** 每收到一段就报**累积到此刻的全文**（界面拿它写「正在写… N 字」）。 */
	readonly onDelta?: (accumulated: string) => void;
	/** 调用方的中止信号（新一轮生成、组件卸载）。 */
	readonly signal?: AbortSignal;
	/** 测试用：换掉 fetch 与空闲计时。 */
	readonly fetchImpl?: typeof fetch;
	readonly idleTimeoutMs?: number;
	/** 两次尝试之间的等待；缺省与 `llm-json.ts` 同一个数。 */
	readonly wait?: (ms: number) => Promise<void>;
}

export type TeachingGenerationResult =
	| { readonly ok: true; readonly spec: TeachingSpec; readonly text: string; readonly attempts: number }
	| {
			readonly ok: false;
			readonly kind: TeachingFailureKind;
			readonly message: string;
			/** schema 不过时逐条列出「哪儿不对」——界面与下一次重试都照着这些字改。 */
			readonly issues: readonly string[];
			/** 已经收到的原文（传输层就没收到过就是 null）。 */
			readonly text: string | null;
			readonly attempts: number;
	  };

/** 两次尝试之间的等待（照 `llm-json.ts` 的 `RETRY_DELAY_MS`）。 */
const defaultWait = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * 要一份教学规格。最多 `attempts` 次（默认 2，与第一条路一致）。
 *
 * 重试的口径与非流式那条路一样：**整段流完了、判据不过 → 再流一次**。
 * 判据就是 `parseTeachingSpec`（形状，加上给了声明时的三段对应关系对账），半成品不参与判断。
 */
export async function generateTeachingSpec(
	options: TeachingGenerationOptions,
): Promise<TeachingGenerationResult> {
	const extras: JsonObject = {
		catalogRef: options.catalog.catalogRef,
		deviceRef: options.deviceRef,
		formatRef: options.formatRef,
		// 覆写共享请求体里那个 512（见文件头第 1 条）。
		max_tokens: TEACHING_MAX_TOKENS,
	};
	const material = teachingMaterialOf(options.declaration, options.catalog, options.declarationText, options.planPaths);
	/**
	 * 上一次为什么没过（**逐条**）。第二次尝试把它附在材料后面。
	 *
	 * 为什么要有这一句：重试发的是**同一段材料**，模型只会在同一个坑里再踩一次
	 * （实测：它把 `body` 写到了 `call` 块上，第二次照样这么写）。判据已经把「哪儿不对」
	 * 逐条说出来了，把它交回去才是真的重试，不是碰运气。
	 */
	let retryNote: string | null = null;
	const messagesForAttempt = (): readonly GenerationMessage[] =>
		teachingMessages(
			retryNote === null ? material : `${material}\n\n【上一次那一份没通过，这些地方要改】\n${retryNote}`,
		);
	/*
	 * 解析时的对账上下文：只有两样都给齐了才带上——**半份上下文比没有更坏**
	 * （表列了却没判据，或判据在而表没列，两种都会让「指不到步」那条判据时灵时不灵）。
	 */
	const context =
		options.planPaths === undefined || options.nodeAtPlanPath === undefined
			? undefined
			: { declaration: options.declaration, nodeAtPlanPath: options.nodeAtPlanPath };
	const attempts = Math.max(1, options.attempts ?? GENERATION_ATTEMPTS);
	const wait = options.wait ?? defaultWait;

	let lastText: string | null = null;
	let failure: { kind: TeachingFailureKind; message: string; issues: readonly string[] } = {
		kind: 'transport',
		message: '没有发起请求',
		issues: [],
	};

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const result = await generateJsonStream({
			messages: messagesForAttempt(),
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
			const parsed = parseTeachingSpec(result.text, context);
			if (parsed.ok) return { ok: true, spec: parsed.spec, text: result.text, attempts: attempt };
			failure = { kind: 'rejected', message: parsed.message, issues: parsed.issues };
			// 下一次带着「哪儿不对」再问一遍（形状不过时 issues 就是那些字；对账不过时同样逐条）。
			retryNote = parsed.issues.join('\n');
		} else if (result.kind === 'aborted') {
			return {
				ok: false,
				kind: 'aborted',
				message: result.error,
				issues: [],
				text: result.text,
				attempts: attempt,
			};
		} else {
			// 后一次连不上时 `text` 是 null：不拿它盖掉前一次已经收到的部分
			// （「拿到过什么就让人看得见」这条不该被重试抹掉）。
			if (result.text !== null) lastText = result.text;
			failure = {
				kind: result.kind === 'response' ? 'response' : 'transport',
				message: result.error,
				issues: [],
			};
		}

		if (attempt < attempts) await wait(RETRY_DELAY_MS);
	}

	return {
		ok: false,
		kind: failure.kind,
		message: failure.message,
		issues: failure.issues,
		text: lastText,
		attempts,
	};
}

/** 「模型没画出这三样」那条诊断的码（界面照它对账，不去匹配 message）。 */
export const TEACHING_FAILED_CODE = 'teaching.generate_failed';

/** 供界面直接摆出来的那条诊断：把「哪儿不对」逐条带上——说不出来就只说失败原因。 */
export const teachingDiagnostic = (
	message: string,
	issues: readonly string[] = [],
	ref?: string,
): Diagnostic => ({
	code: TEACHING_FAILED_CODE,
	severity: 'error',
	message: `模型没画出来：${message}`,
	...(issues.length === 0 ? {} : { details: { issues: [...issues] } }),
	...(ref === undefined ? {} : { ref }),
});

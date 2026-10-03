/**
 * 教学规格的夹具：**一份合格的规格**，形状上把该有的都摆了一个。
 *
 * 它照的是技能计划样例那条任务（看一眼桌面 → 往前挪 → 张开夹爪）里第一段的教学：
 * 起点、观察位、一个「看到了吗」的分支、两条臂、终点；积木是一棵**嵌套**的树
 * （说明块 + 带实参值块的调用块 + 一个 C 形条件块，肚子里还有链），代码是一整段文本。
 *
 * 为什么夹具要这么全：这一版所有判据都是**形状**判据（图连得通、块树拆得开、
 * 队列有东西可铺），形状不全的夹具会让那些判据空转。
 */
import type { TeachingSpec } from '@codecanvas/contracts';

export const TEACHING_SPEC_FIXTURE: TeachingSpec = {
	version: 1,
	title: '看一眼桌面',
	flow: {
		nodes: [
			{ id: 'start', kind: 'start', title: '开始' },
			{ id: 'observe', kind: 'action', title: '移动到观察位', detail: 'pose_name=observe_table' },
			{ id: 'seen', kind: 'decision', title: '看到桌面了吗' },
			{ id: 'plan', kind: 'action', title: '记下桌面快照' },
			{ id: 'again', kind: 'wait', title: '等 1 秒' },
			{ id: 'end', kind: 'end', title: '结束' },
		],
		edges: [
			{ from: 'start', to: 'observe' },
			{ from: 'observe', to: 'seen' },
			{ from: 'seen', to: 'plan', arm: 'then', label: '看到了' },
			{ from: 'seen', to: 'again', arm: 'else' },
			{ from: 'plan', to: 'end' },
			{ from: 'again', to: 'end' },
		],
	},
	blocks: [
		{ kind: 'note', text: '先让相机正对桌面' },
		{
			kind: 'call',
			label: '移动到观察位',
			args: [{ name: 'pose_name', value: { kind: 'text', value: 'observe_table' } }],
		},
		{
			kind: 'if',
			condition: { kind: 'bool', value: true },
			body: [{ kind: 'call', label: '记下桌面快照', args: [] }],
			otherwise: [{ kind: 'wait', seconds: { kind: 'number', value: 1 } }],
		},
	],
	code: ['移动到观察位（pose_name="observe_table"）', '如果画面里有桌面：', '    记下这张快照，后面的规划都看它', '否则：', '    等 1 秒再看一次', ''].join(
		'\n',
	),
};

/** `JSON.stringify` 一版（发请求时用的就是它）。 */
export const teachingSpecJson = (spec: TeachingSpec = TEACHING_SPEC_FIXTURE): string =>
	JSON.stringify(spec);

/** 一份「一块包全部」的不合格规格：一个技能只画一块，实参一个都没有。 */
export const SINGLE_BLOCK_SPEC: TeachingSpec = {
	version: 1,
	title: '偷懒的一份',
	flow: TEACHING_SPEC_FIXTURE.flow,
	blocks: [{ kind: 'call', label: '看一眼桌面', args: [] }],
	code: '看一眼桌面',
};

/** SSE 的一行（`delta.content` 分片）。 */
export const sseFrame = (delta: string): string =>
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`;

export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * 一个能当 `fetch` 用的假响应：正文是一整段 SSE（模型一次性说完）。
 *
 * 与 `stream-ui.test.ts` 里那套「写一块等一块」的握手夹具不同——那边要验**生成途中**的样子，
 * 所以要把流停住；这边只需要「一次说完了」，所以直接一次推完再关。
 */
export const sseResponse = (text: string): Response => {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
	return { ok: true, status: 200, statusText: 'OK', body } as unknown as Response;
};

/** 一份「模型说的是一整份规格」的 SSE 正文。 */
export const sseForSpec = (spec: TeachingSpec = TEACHING_SPEC_FIXTURE): string =>
	`${sseFrame(teachingSpecJson(spec))}${SSE_DONE}`;

/**
 * 把夹具规格真的灌进 store：走的是**完整那条路**（假的 fetch → 流式读 → schema → 铺开），
 * 不是塞一个 ref 进去。视图测试与状态测试都用它，于是两边量的是同一个过程。
 *
 * 动效偏好被打成「关掉」：三条队列一次推满，断言不必等 130ms 的拍子
 * （拍子本身由 `shell/step-playback.test.ts` 用手动时钟验）。
 */
export const loadTeachingFixture = async (spec: TeachingSpec = TEACHING_SPEC_FIXTURE): Promise<void> => {
	const { vi } = await import('vitest');
	const { setSelectedDevice } = await import('../../shell/devices');
	const { loadSampleTask } = await import('../document');
	const { runTeaching } = await import('../teaching');
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => sseResponse(sseForSpec(spec))),
	);
	setSelectedDevice('so101_sim');
	loadSampleTask();
	await runTeaching();
};

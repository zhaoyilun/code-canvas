/**
 * 这一轮教学讲的那份**声明**：四步、带一个分支的技能计划。
 *
 * 为什么夹具不能挂样例任务：样例那条是**三步直线**（看一眼 → 往前挪 → 开夹爪），
 * 里面**没有分支**，`1.then.0` 这种路径根本不存在——而这一版最要紧的判据恰恰是
 * 「框 → 哪一步」指得到。夹具挂一条没有分支的声明，那条判据就永远是空转的。
 *
 * 技能名全部照 `ROBOFRAME_SO101_CATALOG` 里的原名写（技能计划这一路的校验判据是目录，
 * 假名字过不了 `loadTaskJson`，也就测不到真正要测的东西）。
 */
const TEACHING_PLAN: SkillPlan = {
	schemaVersion: 1,
	robot: 'so101_single_arm',
	description: '夹爪分叉演示四步',
	plan: [
		skill('inspect_scene'),
		{
			step: 'if',
			condition: { field: 'last.success', op: '==', value: false },
			then: [skill('close_gripper_skill')],
			else: [skill('open_gripper_skill')],
		},
		skill('move_relative_ee', { motion_direction: 'forward', motion_distance: 0.03 }),
		{ step: 'wait', seconds: 1 },
	],
};

export const TEACHING_PLAN_JSON = JSON.stringify(TEACHING_PLAN, null, 2);

/**
 * 上面那条计划的**执行路径 → 那一步在计划里的样子**（人话，用来核夹具与声明对得上）。
 *
 * 它是 `planPathsOf` 在**这条计划**上的结果（实测：四步里那个分支是顶层第 2 步，
 * 两条臂各一步，所以臂里的路径是 `1.then.0` / `1.else.0`）。夹具的 `planPath` 照它写，
 * 测试里再拿它跟真声明算出来的表对一次——**两处对不上就是夹具坏了，不是实现坏了**。
 */
export const TEACHING_PLAN_STEPS: Readonly<Record<string, string>> = {
	'0': '1. 观察桌面',
	'1': '2. 分支',
	'1.then.0': '3. 关闭夹爪',
	'1.else.0': '4. 打开夹爪',
	'2': '5. 往前一点',
	'3': '6. 等待 1 秒',
};

/**
 * 夹具那份规格里**每一段代码**指的那一步（流程节点 id → 执行路径）。
 *
 * 用途只有一个：测试里拿它把「这一段的行」与「设备跑到的那一步」对上，于是
 * 「切到哪几行」这句话有据可查（不然就只剩「亮了几行」这种读不出对错的断言）。
 * 它在测试里还要与真声明算出来的表核一次——**对不上就是夹具坏了**。
 */
export const TEACHING_SPEC_STEP_OF_SEGMENT: Readonly<Record<string, string>> = {
	observe: '0',
	seen: '1',
	plan: '1.then.0',
	again: '1.else.0',
};

/**
 * 教学规格的夹具：**一份合格的规格**，形状上把该有的都摆了一个。
 *
 * 它讲的就是 `TEACHING_PLAN_JSON` 那条计划：起点的观察、一个「看到了吗」的分支
 * （两条臂各一步）、往前走一点、等一秒、终点；积木是一棵**嵌套**的树
 * （说明块 + 带实参值块的调用块 + 一个 C 形条件块，肚子里还有链），代码按步分段。
 *
 * 为什么夹具要这么全：这一版所有判据都是**形状**判据（图连得通、块树拆得开、
 * 队列有东西可铺、对应关系指得到步），形状不全的夹具会让那些判据空转。
 *
 * 三栏 `planPath` 的写法（这一版新增的那三样）：
 * - 流程节点上的是**执行路径**（`0`、`1.then.0`），照 `TEACHING_PLAN_STEPS` 写；
 * - 积木与代码段上的是**流程节点的 id**（`observe` 那种），指到图上的框。
 */
import type { SkillPlan, TeachingSpec } from '@codecanvas/contracts';

/** 技能步的写法（计划里那个形状；与 `views/flow/__fixtures__/branch-plan.ts` 同一套）。 */
function skill(ref: string, params?: Readonly<Record<string, string | number>>): SkillPlan['plan'][number] {
	return {
		step: 'skill',
		skill: ref,
		...(params === undefined ? {} : { params: { ...params } }),
	} as SkillPlan['plan'][number];
}

export const TEACHING_SPEC_FIXTURE: TeachingSpec = {
	version: 2,
	title: '看一眼桌面',
	flow: {
		nodes: [
			{ id: 'start', kind: 'start', title: '开始' },
			{ id: 'observe', kind: 'action', title: '移动到观察位', detail: 'pose_name=observe_table', planPath: '0' },
			{ id: 'seen', kind: 'decision', title: '看到桌面了吗', planPath: '1' },
			{ id: 'plan', kind: 'action', title: '合上夹爪', planPath: '1.then.0' },
			{ id: 'again', kind: 'wait', title: '等 1 秒', planPath: '1.else.0' },
			{ id: 'end', kind: 'end', title: '结束' },
		],
		edges: [
			{ from: 'start', to: 'observe' },
			{ from: 'observe', to: 'seen' },
			{ from: 'seen', to: 'plan', arm: 'then', label: '没看到' },
			{ from: 'seen', to: 'again', arm: 'else' },
			{ from: 'plan', to: 'end' },
			{ from: 'again', to: 'end' },
		],
	},
	blocks: [
		{ kind: 'note', text: '先让相机正对桌面', planPath: 'observe' },
		{
			kind: 'call',
			label: '移动到观察位',
			planPath: 'observe',
			args: [{ name: 'pose_name', value: { kind: 'text', value: 'observe_table' } }],
		},
		{
			kind: 'if',
			planPath: 'seen',
			condition: { kind: 'bool', value: true },
			body: [{ kind: 'call', label: '合上夹爪', args: [], planPath: 'plan' }],
			otherwise: [{ kind: 'wait', seconds: { kind: 'number', value: 1 }, planPath: 'again' }],
		},
	],
	codeSegments: [
		{ planPath: 'observe', lines: ['移动到观察位（pose_name="observe_table"）'] },
		{ planPath: 'seen', lines: ['如果上一步没成：', '    合上夹爪，把它收回来'] },
		{ planPath: 'plan', lines: ['否则：', '    等 1 秒再看一次'] },
		{ planPath: 'again', lines: ['最后回到起点'] },
	],
	code: [
		'移动到观察位（pose_name="observe_table"）',
		'如果上一步没成：',
		'    合上夹爪，把它收回来',
		'否则：',
		'    等 1 秒再看一次',
		'最后回到起点',
	].join('\n'),
};
/**
 * 一份**联动不生效**的规格：形状合格、图照画、块照画、代码照显示，
 * 但**积木一块归属都没写、代码一段归属都没写**——「哪一块 / 哪几行对应哪一步」这件事
 * 在这份规格里根本不存在。当前步于是哪儿都不亮，而三张画布各自要说一句「跟不了当前步」。
 *
 * 为什么流程那一栏**留着**：三条对应关系是各自独立的，流程那条好着，模型完全可以
 * 只把积木或代码那两条漏掉——那正是这一版最可能出的错，也是「照常画、照实说」要量的东西。
 *
 * `codeSegments` 那一栏的 `planPath` 是形状上**必填**的（少了它 schema 直接不过），
 * 所以「代码那一段没有归属」这件事只能靠**指着一个图外的节点**来表达——那又会被对账层拒。
 * 也就是说：代码那一段没有「漏写照样画」这种状态，只有「指对了」和「整份被拒」两种。
 * 这是有意的（分段没有归属，模型写这一栏就没有意义了），下面这份夹具因此只动积木那一栏。
 */
export const NO_BLOCK_LINKAGE_SPEC: TeachingSpec = {
	...TEACHING_SPEC_FIXTURE,
	title: '没有联动的一份',
	blocks: TEACHING_SPEC_FIXTURE.blocks.map((block) => {
		const { planPath: _drop, ...rest } = block;
		return rest as (typeof TEACHING_SPEC_FIXTURE.blocks)[number];
	}),
};

/**
 * 一段（或几段）代码文本 → `code` 那一栏。
 *
 * 夹具里的 `code` 是**推出来的**，不是手写的：手写一份就等于在夹具里也留了两处真相，
 * 改了一段忘了改另一处时，测的就不是真跑起来那一份了（与契约里那条理由同一个）。
 */
export const codeOfSegments = (segments: readonly { readonly lines: readonly string[] }[]): string =>
	segments.flatMap((segment) => [...segment.lines]).join('\n');

/**
 * `JSON.stringify` 一版（发请求时用的就是它）。
 *
 * `code` 那一栏**要剥掉**：它是我们从 `codeSegments` 拼出来的，模型不该写它，
 * 而 `teachingSpecSchema` 是 `.strict()` 的——带着它发过去，模型给的这份"回复"
 * 会被自己的 schema 判为「多了一个键」。夹具走的必须是模型真的会走的那条路。
 */
export const teachingSpecJson = (spec: TeachingSpec = TEACHING_SPEC_FIXTURE): string => {
	const { code: _derived, ...authored } = spec;
	return JSON.stringify(authored);
};

/** 一份「一块包全部」的不合格规格：一个技能只画一块，实参一个都没有。 */
export const SINGLE_BLOCK_SPEC: TeachingSpec = {
	...TEACHING_SPEC_FIXTURE,
	title: '偷懒的一份',
	blocks: [{ kind: 'call', label: '看一眼桌面', args: [], planPath: 'observe' }],
	codeSegments: [{ planPath: 'observe', lines: ['看一眼桌面'] }],
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
 * 把夹具那条声明灌进 store（**不跑**第二次调用）：只关心声明那几栏的测试用它。
 *
 * 走真那条导入路（`loadTaskJson`），于是第二道闸也真的过一遍——不是塞一份编的声明。
 * `import()` 是**动态**的，而且只在被调用的那一刻才走：夹具文件里不 import 那份状态，
 * 免得一份夹具把整个应用的模块图拖进每一个 import 它的测试（模块级 watch 那种事就是这么来的）。
 */
export const loadTeachingPlan = async (): Promise<void> => {
	const { useStudioDocument } = await import('../document');
	useStudioDocument().loadTaskJson(TEACHING_PLAN_JSON);
};

/**
 * 把夹具规格真的灌进 store：走的是**完整那条路**（假的 fetch → 流式读 → schema → 铺开），
 * 不是塞一个 ref 进去。视图测试与状态测试都用它，于是两边量的是同一个过程。
 *
 * 声明灌的是 `TEACHING_PLAN_JSON`（四步带一个分支），**不是**样例任务那条三步直线：
 * 没有分支就没有 `1.then.0` 这种路径，而这一版的对应关系判据正是围着它转的。
 *
 * 动效偏好被打成「关掉」：三条队列一次推满，断言不必等 130ms 的拍子
 * （拍子本身由 `shell/step-playback.test.ts` 用手动时钟验）。
 */
export const loadTeachingFixture = async (spec: TeachingSpec = TEACHING_SPEC_FIXTURE): Promise<void> => {
	const { vi } = await import('vitest');
	const { setSelectedDevice } = await import('../../shell/devices');
	const { runTeaching } = await import('../teaching');
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => sseResponse(sseForSpec(spec))),
	);
	setSelectedDevice('so101_sim');
	await loadTeachingPlan();
	await runTeaching();
	/*
	 * 等**铺开落定**，不只是"规格到手"。
	 *
	 * 为什么必须等：三张画布是**错峰**开的（流程图 0 / 积木 200 / 代码 400，
	 * 见 `shell/step-playback.ts` 的 `PHASE_DELAY_MS`），代码那一栏最后一格落在 400ms 之后。
	 * 只等解析完成的话，断言"每一行都挂上了入场动画"会因为**一行都还没铺出来**而失败
	 * （实测：`lines.length` 是 0）。等落定之后，三条队列都铺完了，断言量的才是动画本身。
	 */
	const { whenDrawn } = await import('../teaching');
	await whenDrawn();
};

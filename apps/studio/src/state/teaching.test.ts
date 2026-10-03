// @vitest-environment happy-dom
/**
 * 教学规格这一条线的状态机：**第二次调用**跑起来以后，三张画布各自拿到什么。
 *
 * 这一组守四件事：
 *
 * 1. **铺开序**：流程图从开始节点出发、节点先出边后；嵌套的块树深度优先、先父后子
 *    ——「一块块落进来」在嵌套的树上也成立；
 * 2. **一次成功的调用**：状态从 drawing 到 ready，规格进 `spec`，三条队列都拿到自己的序列；
 * 3. **失败不许静默**：形状不对要说清「哪儿不对」，传输坏了要说清是什么坏了，
 *    而且**不许**把上一份规格悄悄留着装作没事（`failure` 与 `spec` 是两个独立的事实）；
 * 4. **不碰声明**：跑完一轮，`store.declaration` 与它的 digest 一个字节都不变。
 *
 * 动效偏好在这组里被打成 `reduce`：于是三条队列一次推到满，断言不必等 130ms 的拍子
 * （拍子本身的行为由 `shell/step-playback.test.ts` 用手动时钟验）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkflowDigest, type TeachingSpec } from '@codecanvas/contracts';
import { useStudioDocument } from './document';
import { codeLinesOf, flowDrawOrder, runTeaching, useTeaching, useTeachingLinkage } from './teaching';
import { setSelectedDevice } from '../shell/devices';
import { clearRunningPlanPath, setRunningPlanPath } from '../shell/device-run';
import {
	loadTeachingFixture,
	SINGLE_BLOCK_SPEC,
	sseFrame,
	sseForSpec,
	sseResponse,
	SSE_DONE,
	TEACHING_PLAN_JSON,
	TEACHING_PLAN_STEPS,
	TEACHING_SPEC_FIXTURE,
} from './__fixtures__/teaching-spec';
import { nodeAtPlanPath, planPathsOf } from '../views/shared/plan-structure';

const doc = useStudioDocument();
const teaching = useTeaching();

const realMatchMedia = window.matchMedia;

/** 把动效偏好打成「关掉」：三条队列因此一次推满（见 `state/teaching.ts` 的 `prefersReducedMotion`）。 */
const stubReducedMotion = (): void => {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: query.includes('prefers-reduced-motion'),
			media: query,
			onchange: null,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});
};

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
	vi.stubGlobal('fetch', vi.fn(impl));
};

beforeEach(() => {
	stubReducedMotion();
	setSelectedDevice('so101_sim');
	// 声明灌的是夹具那条**四步带分支**的计划（不是样例任务那条三步直线）：
	// 没有分支就没有 `1.then.0`，而这一版的对应关系判据正是围着它转的。
	expect(doc.loadTaskJson(TEACHING_PLAN_JSON)).toBe(true);
});

afterEach(() => {
	vi.unstubAllGlobals();
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia });
});

describe('流程图的铺开序', () => {
	it('从开始节点出发：节点先、它的出边随后', () => {
		const order = flowDrawOrder(TEACHING_SPEC_FIXTURE.flow);
		expect(order[0]?.key).toBe('node:start');
		expect(order[1]?.key).toBe('edge:start->observe:main');
		expect(order[2]?.key).toBe('node:observe');
	});

	it('一个分支的两条臂：「是」那一路先落，「否」那一路后落', () => {
		const order = flowDrawOrder(TEACHING_SPEC_FIXTURE.flow).map((item) => item.key);
		const thenEdge = order.indexOf('edge:seen->plan:then');
		const elseEdge = order.indexOf('edge:seen->again:else');
		expect(thenEdge).toBeGreaterThan(-1);
		expect(elseEdge).toBeGreaterThan(thenEdge);
	});

	it('走不到的节点也不会漏画：排在最后（宁可画在末尾，也不因为推不出顺序就少画一个）', () => {
		const graph = { ...TEACHING_SPEC_FIXTURE.flow, edges: [] };
		const order = flowDrawOrder(graph);
		expect(order.filter((item) => item.kind === 'node')).toHaveLength(graph.nodes.length);
	});
});

describe('跑一轮第二次调用', () => {
	it('成功：状态 ready、规格进 store、三条队列都铺满（动效关掉时一次到位）', async () => {
		stubFetch(async () => sseResponse(sseForSpec()));

		await runTeaching();

		expect(teaching.status.value).toBe('ready');
		expect(teaching.failure.value).toBeNull();
		expect(teaching.spec.value?.title).toBe(TEACHING_SPEC_FIXTURE.title);
		// 三条队列各自铺满：节点 + 边、块树（含值块）、代码行。
		expect(teaching.revealedFlowKeys.value.size).toBe(
			TEACHING_SPEC_FIXTURE.flow.nodes.length + TEACHING_SPEC_FIXTURE.flow.edges.length,
		);
		expect(teaching.revealedBlockItems.value.length).toBeGreaterThan(TEACHING_SPEC_FIXTURE.blocks.length);
		// 行序与视图同一处口径（`codeLinesOf`）：末尾的空行不算一格。
		expect(teaching.revealedCodeLines.value).toEqual(codeLinesOf(TEACHING_SPEC_FIXTURE.code));
	});

	it('跑一轮不动声明：digest 与节点一个字节都不变（教学不是命令）', async () => {
		const before = doc.declaration.value;
		expect(before).not.toBeNull();
		const digestBefore = before === null ? '' : computeWorkflowDigest(before);
		stubFetch(async () => sseResponse(sseForSpec()));

		await runTeaching();

		expect(doc.declaration.value).toEqual(before);
		expect(doc.declaration.value?.digest).toBe(before?.digest);
		expect(digestBefore).toBe(before?.digest);
	});

	it('形状不对：说出「哪儿不对」，并且不把这份规格当成画好了', async () => {
		stubFetch(async () => sseResponse(sseForSpec(SINGLE_BLOCK_SPEC)));

		await runTeaching();

		expect(teaching.status.value).toBe('failed');
		expect(teaching.spec.value).toBeNull();
		expect(teaching.failure.value?.issues.join('\n')).toContain('一块包全部');
	});

	/**
	 * 这一条钉的是**对账那一次接线**：生成那条路必须把声明交给解析器。
	 *
	 * 不接的话，「模型给了一个指不到步的 planPath」会被放过去，屏幕上就是三处一个都不亮
	 * 而没人说得清为什么——那正是这一版要拦的那种失败。形状层拦不住它（那条路径**长得完全合法**）。
	 */
	it('指到一个不存在的步：整份被拒，理由逐条说出来', async () => {
		const broken: TeachingSpec = {
			...TEACHING_SPEC_FIXTURE,
			flow: {
				...TEACHING_SPEC_FIXTURE.flow,
				nodes: TEACHING_SPEC_FIXTURE.flow.nodes.map((node) =>
					node.id === 'observe' ? { ...node, planPath: '7' } : node,
				),
			},
		};
		stubFetch(async () => sseResponse(sseForSpec(broken)));

		await runTeaching();

		expect(teaching.status.value).toBe('failed');
		expect(teaching.spec.value).toBeNull();
		expect(teaching.failure.value?.message).toContain('对不上');
		expect(teaching.failure.value?.issues.join('\n')).toContain('没有对应的步骤');
	});

	it('第一次形状不对、第二次对了：重试一次就成（判据是整段说完了才看）', async () => {
		let call = 0;
		stubFetch(async () => {
			call += 1;
			return sseResponse(call === 1 ? sseForSpec(SINGLE_BLOCK_SPEC) : sseForSpec());
		});

		await runTeaching();

		expect(call).toBe(2);
		expect(teaching.status.value).toBe('ready');
		expect(teaching.attempt.value).toBe(2);
	});

	it('接口坏了：照实说是传输层坏了，并把已经收到的原文留着', async () => {
		stubFetch(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway' }) as unknown as Response);

		await runTeaching();

		expect(teaching.status.value).toBe('failed');
		expect(teaching.failure.value?.message).toContain('502');
		expect(teaching.failure.value?.text).toBeNull();
	});

	it('流读一半断了：已经收到的部分要留着（拿到过什么就让人看得见）', async () => {
		stubFetch(async () => sseResponse(`${sseFrame('{"version":1,"title":"半截')}`));

		await runTeaching();

		expect(teaching.status.value).toBe('failed');
		expect(teaching.failure.value?.text).toContain('半截');
	});

	it('没有声明时不发请求，状态回到 idle（材料都凑不齐，发出去只会得到一份编的）', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		// 把声明清掉：这一条量的是「凑不齐材料就什么都不做」。
		const declaration = doc.declaration.value;
		doc.declaration.value = null;

		await runTeaching();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(teaching.status.value).toBe('idle');

		doc.declaration.value = declaration;
	});

	it('状态是独立的两个事实：失败之后再成功一次，failure 要清掉', async () => {
		stubFetch(async () => sseResponse(sseForSpec(SINGLE_BLOCK_SPEC)));
		await runTeaching();
		expect(teaching.failure.value).not.toBeNull();

		stubFetch(async () => sseResponse(sseForSpec()));
		await runTeaching();
		expect(teaching.status.value).toBe('ready');
		expect(teaching.failure.value).toBeNull();
	});

	it('带 [DONE] 的整段流：解析出来的就是最后一版（哨兵不参与内容）', async () => {
		stubFetch(async () => sseResponse(`${sseFrame('{"version":1,')}${sseFrame('"title":"看一眼桌面",')}${SSE_DONE}`));
		await runTeaching();
		// 半截 JSON 自然是失败的——这一条要的是「失败也要有说法」，不是「半截能拼出来」。
		expect(teaching.status.value).toBe('failed');
		expect(teaching.failure.value?.message).toContain('不是 JSON');
	});
});

/**
 * 这一版最要紧的一条：**设备跑到哪一步，三处跟着走到哪儿**。
 *
 * 判据只有一处（`useTeachingLinkage` 的 `currentNodeId`），三张画布都从它派生——
 * 所以这一组钉的是「那一个数怎么算出来的」：设备那条路径优先、没有就看选中、
 * 推不出来就**什么都不亮**（不猜一个顶上）。三张画布各自怎么用这个数，由它们自己的测试钉。
 */
describe('联动：执行到哪一步 → 哪一个流程节点', () => {
	/** 夹具的三栏 `planPath` 与真声明算出来的路径表**逐条对上**（对不上就是夹具坏了）。 */
	it('夹具的 planPath 与真声明算出来的执行路径逐条对得上', () => {
		const declaration = doc.declaration.value;
		const paths = planPathsOf(declaration);
		const actual = Object.fromEntries([...paths].map(([path, node]) => [path, node.name]));
		expect(actual).toEqual(TEACHING_PLAN_STEPS);
		for (const node of TEACHING_SPEC_FIXTURE.flow.nodes) {
			if (node.planPath === undefined) continue;
			expect(nodeAtPlanPath(declaration, node.planPath)).not.toBeNull();
		}
	});

	it('设备报的那一步 → 图上那个框（`runningPlanPath` 是硬事实，优先）', async () => {
		await loadTeachingFixture();
		const linkage = useTeachingLinkage();
		expect(linkage.currentNodeId.value).toBeNull();
		expect(linkage.linkage.value).toBe('linked');

		setRunningPlanPath('1.then.0');
		expect(linkage.currentNodeId.value).toBe('plan');
		expect(linkage.currentPlanPath.value).toBe('1.then.0');

		setRunningPlanPath('1');
		expect(linkage.currentNodeId.value).toBe('seen');

		clearRunningPlanPath();
		expect(linkage.currentNodeId.value).toBeNull();
	});

	it('没在跑时看选中：选中哪一步就亮哪个框（跑完停在最后一步的那条路）', async () => {
		await loadTeachingFixture();
		const declaration = doc.declaration.value;
		const linkage = useTeachingLinkage();
		const node = nodeAtPlanPath(declaration, '1.else.0');
		if (node === null) throw new Error('夹具的路径推不出节点');

		doc.select(node.id);
		expect(linkage.currentNodeId.value).toBe('again');
		doc.select(null);
		expect(linkage.currentNodeId.value).toBeNull();
	});

	it('这一步在图上没有对应的框：**什么都不亮**，不拿别的框顶上', async () => {
		await loadTeachingFixture();
		const linkage = useTeachingLinkage();
		// `2` 是「往前一点」那一步，夹具的图上只讲了前面那几步，没有它的框。
		setRunningPlanPath('2');
		expect(linkage.currentPlanPath.value).toBe('2');
		expect(linkage.currentNodeId.value).toBeNull();
		clearRunningPlanPath();
	});

	it('设备报的那条路径推不出步骤：也不拿另一条顶上', async () => {
		await loadTeachingFixture();
		const linkage = useTeachingLinkage();
		setRunningPlanPath('9.then.0');
		expect(linkage.currentNodeId.value).toBeNull();
		clearRunningPlanPath();
	});

	it('这份规格有没有一条能用的对应关系：三处各自算得出来', async () => {
		await loadTeachingFixture();
		const linkage = useTeachingLinkage();
		expect(linkage.linkage.value).toBe('linked');
		expect(linkage.note.value).toBe('');
		// 块树的归属（与播放队列同序，值块跟着它那个调用块）。
		expect(linkage.blockAnchorsOf.value.filter((anchor) => anchor !== undefined).length).toBeGreaterThan(0);
		// 代码分段的每一段都给得出一段连续的行范围。
		for (const range of linkage.codeRangesOf.value) expect(range.to).toBeGreaterThanOrEqual(range.from);
	});

	/**
	 * 联动状态那三档里 `none` 那一档：**还没有规格**。
	 *
	 * 单独一条、且把 `spec` 存下来再放回去：它是模块级单例，上一条测试留下的那一份会跟过来
	 * （这一组的其它测试都不看 `linkage`，所以只有这里要动手）。
	 */
	it('还没有规格时是 none：那不是说联动坏了，是说还没东西可联动', async () => {
		await loadTeachingFixture();
		const teaching = useTeaching();
		const linkage = useTeachingLinkage();
		const kept = teaching.spec.value;
		teaching.spec.value = null;
		expect(linkage.linkage.value).toBe('none');
		expect(linkage.note.value).toBe('');
		expect(linkage.currentNodeId.value).toBeNull();
		teaching.spec.value = kept;
	});
});

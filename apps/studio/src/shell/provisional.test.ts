// @vitest-environment happy-dom
/**
 * 半成品解析那一层的验收（`provisional.ts`）：模型吐到一半的 JSON 能解析出多少。
 *
 * 这一层守两件事，缺一不可：
 *
 * 1. **容错**：完整 JSON、截在步骤中间、截在字符串中间、带围栏、数组还没闭合、`plan` 键还没出现——
 *    每一种都要给出**说得清的**结果（解出几步、解出来的是不是那几步、解不出时也不抛）。
 *    判据是"括号闭合了才算一步"，所以这里连字符串里的括号、转义引号都单独试一遍：
 *    它们踩错一处，整份预览就会多出或少掉一步，而那种错在界面上很难看出来。
 * 2. **它永远不是真相**：同一段半成品解析一百遍，`state/document.ts` 的 `declaration`
 *    与它的 `digest` 一个字节都不许变。这条直接钉在测试里，因为它正是这一层存在的边界——
 *    半成品可以随便长、随便变，真相只有一个入口（过了两道闸的定稿）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { computeWorkflowDigest } from '@codecanvas/contracts';
import { loadSampleTask, useStudioDocument } from '../state/document';
import { SAMPLE_SKILL_PLAN_JSON } from '../state/sample-skill-plan';
import { setSelectedDevice } from './devices';
import { parseProvisionalSkillPlan } from './provisional';

const doc = useStudioDocument();

/** 一个包着 `plan` 的骨架；中间那段由各条用例自己给（这就是"正在吐的那一段"）。 */
const wrapped = (body: string): string =>
	`{"schemaVersion":1,"robot":"so101_single_arm","description":"看一眼桌面",${body}`;

/** 步骤里的技能名：真名就取目录里第一个技能——写死一个字符串，目录改名测试就假绿了。 */
const REAL_SKILL = ROBOFRAME_SO101_CATALOG.capabilities[0]?.capabilityRef ?? '';
if (REAL_SKILL === '') throw new Error('目录里一个技能都没有，这条测试的前提不成立');

beforeEach(() => {
	setSelectedDevice('so101_sim');
	expect(loadSampleTask()).toBe(true);
});

/**
 * 当前真相的**指纹**：声明对象本身 + 它的 digest。
 *
 * 用 digest 而不是只比对象引用：`loadTaskJson` 会换一个新对象，但"内容碰巧一样"也能过引用比较
 * ——比 digest 才能说"一个字节都没变"。
 */
const truthFingerprint = (): string => {
	const declaration = doc.declaration.value;
	if (declaration === null) return 'null';
	return `${declaration.digest}|${computeWorkflowDigest(declaration)}|${String(declaration.nodes.length)}`;
};

describe('半成品 · 能解析出多少算多少', () => {
	it('完整 JSON：三步全解出来，顺序与内容都对', () => {
		const plan = parseProvisionalSkillPlan('skill_plan', SAMPLE_SKILL_PLAN_JSON);

		expect(plan).not.toBeNull();
		expect(plan?.stepCount).toBe(3);
		expect(plan?.sawPlanKey).toBe(true);
		expect(plan?.plan.robot).toBe('so101_single_arm');
		expect(plan?.plan.description).toBe('看一眼桌面，往前挪一点，打开夹爪');
		// 三步各一个节点，参数就照原文那样平铺进节点参数（与非流式那条路同一个函数）
		expect(plan?.declaration.nodes).toHaveLength(3);
		expect(plan?.declaration.nodes[0]?.parameters['action']).toBe('inspect_scene');
	});

	it('截在步骤中间：闭合了的那一步算数，没闭合的那一步原样丢着', () => {
		const text = wrapped(`"plan":[{"step":"skill","skill":"${REAL_SKILL}"},{"step":"skill","skill":"wave_he`);
		const plan = parseProvisionalSkillPlan('skill_plan', text);

		expect(plan?.stepCount).toBe(1);
		expect(plan?.declaration.nodes).toHaveLength(1);
		expect(plan?.declaration.nodes[0]?.parameters['action']).toBe(REAL_SKILL);
	});

	it('截在字符串中间：字符串内部不算结构，尾段丢掉、前面照留', () => {
		const text = `{"schemaVersion":1,"robot":"so101_single_a`;
		const plan = parseProvisionalSkillPlan('skill_plan', text);

		// `plan` 还没出现，所以零步——但 robot 那半截字符串照读（它是个名字，不是结构）
		expect(plan?.stepCount).toBe(0);
		expect(plan?.sawPlanKey).toBe(false);
		expect(plan?.plan.robot).toBe('so101_single_a');
		expect(plan?.declaration.nodes).toHaveLength(0);
	});

	it('字符串里的括号与转义引号不算结构：一步就是一步', () => {
		const text = wrapped(
			`"plan":[{"step":"skill","skill":"${REAL_SKILL}","params":{"note":"}{ 他说 \\"好\\" 然后 }"}},{"step":"wait","seconds":2}]`,
		);
		const plan = parseProvisionalSkillPlan('skill_plan', text);

		// 若把字符串里的 `}` 当成结构，这里会解出 2 步或更多（多出来的都是假的）
		expect(plan?.stepCount).toBe(2);
		expect(plan?.declaration.nodes[0]?.parameters['action']).toBe(REAL_SKILL);
		expect(plan?.declaration.nodes[1]?.parameters['seconds']).toBe(2);
	});

	it('带围栏的 ```json：围栏剥掉之后照样解', () => {
		const text = `\`\`\`json\n${SAMPLE_SKILL_PLAN_JSON}\n\`\`\``;
		const stripped = text.replace(/^```json\n/, '').replace(/\n```$/, '');

		// 这一层自己**不剥围栏**（那是 `llm-stream.ts` 的事，见 `envelopeContentOf`）；
		// 所以这里喂的是剥好的那一份——界面那条路上拿到的也是剥好的。
		expect(parseProvisionalSkillPlan('skill_plan', stripped)?.stepCount).toBe(3);
		// 没剥的那一份也解得出来：`planArrayStart` 找的是 `"plan"` 与它后面那个 `[`，
		// 围栏在这两样**前面**，所以定位不受影响（围栏是给剥栏那一步看的，不是给这里看的）。
		expect(parseProvisionalSkillPlan('skill_plan', text)?.stepCount).toBe(3);
	});

	it('数组还没闭合（最后一步的 } 还没来）：只算已经闭合的那些', () => {
		const text = wrapped(`"plan":[{"step":"skill","skill":"${REAL_SKILL}"},{"step":"wait","seconds":2}`);
		const plan = parseProvisionalSkillPlan('skill_plan', text);

		// 第二个对象闭合了、但数组还没闭合：它**算**（判据是对象自己闭合，不是数组闭合）
		expect(plan?.stepCount).toBe(2);
		expect(plan?.declaration.nodes).toHaveLength(2);
	});

	it('数组闭合之后模型又重吐一版：只认第一版，不把两版拼成一份没人写过的计划', () => {
		const text = wrapped(
			`"plan":[{"step":"wait","seconds":1}]},{"plan":[{"step":"wait","seconds":2},{"step":"wait","seconds":3}]`,
		);
		const plan = parseProvisionalSkillPlan('skill_plan', text);

		// 读到第一个 `]` 就收手：后面那一版一个字都不算
		expect(plan?.stepCount).toBe(1);
		expect(plan?.declaration.nodes[0]?.parameters['seconds']).toBe(1);
	});

	it('plan 键还没出现：零步、不抛，但原文那一份骨架该读出来的照读', () => {
		const plan = parseProvisionalSkillPlan('skill_plan', '{"schemaVersion":1,"robot":"so101_single_arm"');

		expect(plan).not.toBeNull();
		expect(plan?.stepCount).toBe(0);
		expect(plan?.sawPlanKey).toBe(false);
		expect(plan?.declaration.nodes).toHaveLength(0);
	});

	it('空文本、乱码、半个转义：一律零步且不抛', () => {
		for (const text of ['', '   ', '不是 JSON', '{', '[', '{"plan":[', '{"plan":[{"step":"skill"']) {
			expect(() => parseProvisionalSkillPlan('skill_plan', text)).not.toThrow();
			expect(parseProvisionalSkillPlan('skill_plan', text)?.stepCount).toBe(0);
		}
	});

	it('一个坏对象不拖累后面的：解析不了的那一步跳过，别的照出', () => {
		const text = wrapped(
			`"plan":[{"step":"skill","skill":"${REAL_SKILL}","params":{"options":[1,2,]}},{"step":"wait","seconds":2}]`,
		);
		const plan = parseProvisionalSkillPlan('skill_plan', text);

		// 第一个对象的括号闭合了，但内容不是合法 JSON（数组里多了个逗号）：跳过它
		expect(plan?.stepCount).toBe(1);
		expect(plan?.declaration.nodes[0]?.parameters['seconds']).toBe(2);
	});

	it('目录里查不到的技能照常显示（它是幽灵态，本来就还没校验）', () => {
		const text = wrapped(`"plan":[{"step":"skill","skill":"这个技能根本不在目录里"}]`);
		const plan = parseProvisionalSkillPlan('skill_plan', text);

		expect(plan?.stepCount).toBe(1);
		// 查不到就照出原名——不替模型认一个名字（目录这时给的是"什么都不知道"那一份）
		expect(plan?.declaration.nodes[0]?.parameters['action']).toBe('这个技能根本不在目录里');
		expect(plan?.declaration.nodes[0]?.name).toContain('这个技能根本不在目录里');
	});

	it('同一段文本解析两次给同一份东西（含节点 id）', () => {
		const first = parseProvisionalSkillPlan('skill_plan', SAMPLE_SKILL_PLAN_JSON);
		const second = parseProvisionalSkillPlan('skill_plan', SAMPLE_SKILL_PLAN_JSON);

		expect(second?.declaration.nodes.map((node) => node.id)).toEqual(
			first?.declaration.nodes.map((node) => node.id),
		);
	});

	it('别的格式没有半成品解析：返回 null（界面据此不摆幽灵态）', () => {
		expect(parseProvisionalSkillPlan('phase1_task', SAMPLE_SKILL_PLAN_JSON)).toBeNull();
	});
});

describe('半成品 · 真相一个字节都不动', () => {
	it('解析半成品这件事本身不碰 store：声明与 digest 全程不变', () => {
		const before = truthFingerprint();
		const declarationBefore = doc.declaration.value;

		for (const text of [
			'{"schemaVersion":1,"robot":"so101_single_arm","plan":[',
			wrapped(`"plan":[{"step":"skill","skill":"${REAL_SKILL}"}]`),
			SAMPLE_SKILL_PLAN_JSON,
			'',
			'坏掉的一段',
		]) {
			parseProvisionalSkillPlan('skill_plan', text);
		}

		expect(truthFingerprint()).toBe(before);
		expect(doc.declaration.value).toBe(declarationBefore);
	});

	it('这一层不调用校验器：`validateSkillPlan` 一次都不响', async () => {
		/*
		 * 判据是**这个模块没有走校验那条路**。做法：把 `@codecanvas/contracts` 整个替身掉，
		 * 其中 `validateSkillPlan` 换成一个记账的假函数——只要有人从这条路调它，这里就看得见。
		 *
		 * ⚠ 这条测试的诚实说明：`provisional.ts` 里根本没有那个名字的 import，所以它**首先**是
		 * 一条"将来有人顺手加上去会被拦下"的哨兵，而不是"现在它真的在调、被我们抓住了"的证据。
		 * 真正说明"半成品不校验"的是另一条：非法半成品照样出幽灵卡（见下面 `渲染` 那一组）。
		 */
		const validateSkillPlan = vi.fn(() => ({ ok: false, diagnostics: [] }));
		vi.doMock('@codecanvas/contracts', async (importOriginal) => {
			const actual = await importOriginal<typeof import('@codecanvas/contracts')>();
			return { ...actual, validateSkillPlan };
		});
		vi.resetModules();

		const fresh = await import('./provisional');
		const plan = fresh.parseProvisionalSkillPlan('skill_plan', SAMPLE_SKILL_PLAN_JSON);

		// 替身真的生效了：拿到的还是那份计划，而假校验器一次没响
		expect(plan?.stepCount).toBe(3);
		expect(validateSkillPlan).not.toHaveBeenCalled();
		vi.doUnmock('@codecanvas/contracts');
		vi.resetModules();
	});
});

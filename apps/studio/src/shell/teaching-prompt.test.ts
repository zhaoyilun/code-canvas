// @vitest-environment happy-dom
/**
 * 提示词材料：**全部由目录现生成**，一个字都不手写。
 *
 * 这一组的判据是「材料跟着目录走」——所以每条断言都拿**改动过的目录**去问材料，
 * 而不是问「里面有没有某个字符串」（那种断言在手写一份清单时照样绿）。
 *
 * 三块材料各自对应一件事实：
 * 1. 技能清单：改一个技能的 label / 参数 → 材料跟着变，且条数就是目录里技能的条数；
 * 2. 执行侧接口名（新补的第一层）：上游 YAML 里的那几条；
 * 3. 设备事实（`describeDeviceFacts` 那一层）：这次任务用到的那一步**落到哪个坐标**——
 *    材料里要出现目录里那个真实数字，而不是「有一个位姿表」这种空话。
 */
import { describe, expect, it } from 'vitest';
import {
	describeDeviceFacts,
	findCapability,
	parseTeachingSpec,
	type CapabilityCatalog,
} from '@codecanvas/contracts';
import { ROBOFRAME_SO101_CATALOG } from '@codecanvas/capabilities';
import { useStudioDocument } from '../state/document';
import { setSelectedDevice } from './devices';
import { TEACHING_SYSTEM_PROMPT, teachingMaterialOf } from './teaching-prompt';
import { generateTeachingSpec } from './teaching-generation';
import { planPathsOf } from '../views/shared/plan-structure';
import {
	codeOfSegments,
	loadTeachingPlan,
	SINGLE_BLOCK_SPEC,
	sseForSpec,
	sseResponse,
	TEACHING_PLAN_STEPS,
	TEACHING_SPEC_FIXTURE,
	teachingSpecJson,
} from '../state/__fixtures__/teaching-spec';

/**
 * 这一组用的那份声明：夹具那条**四步带分支**的计划（`TEACHING_PLAN_JSON`）。
 *
 * 为什么不用样例任务：材料里这一版多了一块「每一步的执行路径」，而样例那条三步直线
 * 没有分支，`1.then.0` 这种路径根本不存在——拿它测「模型照这张表抄 planPath」等于测不到。
 */
const declarationOf = async () => {
	setSelectedDevice('so101_sim');
	await loadTeachingPlan();
	const declaration = useStudioDocument().declaration.value;
	if (declaration === null) throw new Error('夹具计划没灌进来');
	return declaration;
};

/** 材料里那一段「技能清单」的行（`- ref（label）：…`）。 */
const skillLines = (material: string): readonly string[] => {
	const section = material.split('【技能清单（目录原文，技能名只能从这里来）】')[1] ?? '';
	return (section.split('\n【')[0] ?? '').split('\n').filter((line) => line.startsWith('- '));
};

describe('材料由目录现生成', () => {
	it('技能清单的条数就是目录里技能的条数，名字逐字来自目录', async () => {
		const material = teachingMaterialOf((await declarationOf()), ROBOFRAME_SO101_CATALOG, '{}');
		const lines = skillLines(material);
		expect(lines).toHaveLength(ROBOFRAME_SO101_CATALOG.capabilities.length);
		for (const capability of ROBOFRAME_SO101_CATALOG.capabilities) {
			expect(lines.some((line) => line.startsWith(`- ${capability.capabilityRef}（${capability.label}）`))).toBe(true);
		}
	});

	it('改目录里一个技能的 label 与参数 → 材料跟着变（提示词不是第二份目录）', async () => {
		const target = 'inspect_scene';
		const renamed: CapabilityCatalog = {
			...ROBOFRAME_SO101_CATALOG,
			capabilities: ROBOFRAME_SO101_CATALOG.capabilities.map((capability) =>
				capability.capabilityRef === target
					? { ...capability, label: '看一眼桌面（改过的）', summary: '改过的说法' }
					: capability,
			),
		};
		const material = teachingMaterialOf((await declarationOf()), renamed, '{}');
		expect(material).toContain('看一眼桌面（改过的）');
		expect(material).toContain('改过的说法');
		// 技能清单那一段里不再有旧名字（任务 JSON 那段里出现的是**任务里那一步的名字**，
		// 与技能清单是两回事，所以这里只看清单那一段）。
		expect(skillLines(material).join('\n')).not.toContain('（观察桌面）');
	});

	it('新补的第一层：接口名表照上游 YAML 的键与值写进材料', async () => {
		const material = teachingMaterialOf((await declarationOf()), ROBOFRAME_SO101_CATALOG, '{}');
		expect(material).toContain('skill_action_name = /embodied/execute_skill');
		expect(material).toContain('primitive_action_name = /embodied/execute_primitive');
		expect(material).toContain('validate_skill_service = /embodied/validate_skill');
	});

	it('新补的第二层：原语要设备先具备哪些运行时能力（含上游那句「缺了怎么说」）', async () => {
		const material = teachingMaterialOf((await declarationOf()), ROBOFRAME_SO101_CATALOG, '{}');
		expect(material).toContain('要设备先具备：');
		expect(material).toContain('fresh_ee_pose（缺了的话网关说：ee pose unavailable or stale）');
	});

	it('设备事实落到这一次的取值上：观察位那个坐标是目录里的真数字', async () => {
		const declaration = (await declarationOf());
		const material = teachingMaterialOf(declaration, ROBOFRAME_SO101_CATALOG, '{}');
		const target = ROBOFRAME_SO101_CATALOG.namedPoseTargets?.find((pose) => pose.name === 'observe_table');
		expect(target?.position).toBeDefined();
		expect(material).toContain('pose_name="observe_table" → named_poses.observe_table');
		expect(material).toContain(`x=${String(target?.position?.x)}`);
		expect(material).toContain(`z=${String(target?.position?.z)}`);
		// 同一件事也能从目录那一侧直接问出来（两边说的是同一句话）。
		const capability = findCapability(ROBOFRAME_SO101_CATALOG, 'inspect_scene');
		const primitive = ROBOFRAME_SO101_CATALOG.primitives.find((item) => item.primitiveRef === 'move_to_named_pose');
		const facts = describeDeviceFacts(ROBOFRAME_SO101_CATALOG, primitive!, { pose_name: 'observe_table' });
		expect(facts.join('\n')).toContain('named_poses.observe_table');
		expect(capability?.implementation.length).toBe(1);
	});

	it('任务 JSON 那段就是**这一份**声明（不是重新编的一份）', async () => {
		const declaration = (await declarationOf());
		const text = JSON.stringify(declaration, null, 2);
		const material = teachingMaterialOf(declaration, ROBOFRAME_SO101_CATALOG, text);
		// 原文照进材料：声明名、那个开头的 `{`、以及它自己的 digest 都在。
		expect(material).toContain(declaration.name);
		expect(material).toContain(declaration.digest);
		expect(material).toContain(text.slice(0, 40));
	});

	it('system 那段把三条纪律都写着：照目录说、不许编数值、不许一块包全部', () => {
		expect(TEACHING_SYSTEM_PROMPT).toContain('不许一块包全部');
		expect(TEACHING_SYSTEM_PROMPT).toContain('不许编具体数值');
		expect(TEACHING_SYSTEM_PROMPT).toContain('必须照目录说');
		// 「写着实现的技能要展开成多块」这一条是这一版最容易做错的地方，提示词里必须说清。
		expect(TEACHING_SYSTEM_PROMPT).toContain('展开成多块');
	});
});

/**
 * 这一版加的那一块材料与那三条要求：**三处对应关系**（流程图节点 / 积木 / 代码分段
 * 各自指着声明里的哪一步）。
 *
 * 判据分两面：
 * 1. **材料跟着目录/声明走**——「每一步的执行路径」那张表是 `planPathsOf` 列出来的，
 *    不是手写的一份清单：换一份声明，表跟着换（这一条与上面那组同一个用意）；
 * 2. **提示词要求里含那三样**，且**说清写错的后果**（写错会怎样不是修辞：那正是校验器会做的事）。
 */
describe('对应关系那三样', () => {
	it('材料里那张「每一步的执行路径」表就是声明算出来的那张（不是手写清单）', async () => {
		const declaration = (await declarationOf());
		const paths = planPathsOf(declaration);
		const material = teachingMaterialOf(declaration, ROBOFRAME_SO101_CATALOG, '{}', paths);
		// 表里每一条路径都在材料里，而且每条路径后面跟着它那一步的显示名（模型靠名字认步）。
		for (const [path, node] of paths) expect(material).toContain(`- ${path} ← ${node.name}`);
		// 路径表里的分支那两条（`1.then.0` / `1.else.0`）必须在——这一版要的正是它们。
		expect(material).toContain('- 1.then.0 ←');
		expect(material).toContain('- 1.else.0 ←');
		expect(Object.keys(TEACHING_PLAN_STEPS).every((path) => material.includes(`- ${path} ←`))).toBe(true);
	});

	it('换一份声明，材料那张表跟着换（表由声明现生成）', async () => {
		const declaration = (await declarationOf());
		const other = {
			...declaration,
			// 只留第一步：这一份声明里没有分支，`1.then.0` 那条路径也就不该出现在材料里。
			nodes: declaration.nodes.slice(0, 1),
			connections: {},
		};
		const material = teachingMaterialOf(other, ROBOFRAME_SO101_CATALOG, '{}', planPathsOf(other));
		expect(material).toContain('- 0 ←');
		expect(material).not.toContain('- 1.then.0 ←');
	});

	it('不给那张表时材料照旧（少一块，不编一块）', async () => {
		const declaration = (await declarationOf());
		const material = teachingMaterialOf(declaration, ROBOFRAME_SO101_CATALOG, '{}');
		expect(material).not.toContain('每一步的执行路径');
	});

	it('提示词要求模型写出那三样对应关系，并把写错的后果说清', () => {
		// 三样各写一处：流程节点、积木、代码分段。
		expect(TEACHING_SYSTEM_PROMPT).toContain('"planPath"');
		expect(TEACHING_SYSTEM_PROMPT).toContain('codeSegments');
		expect(TEACHING_SYSTEM_PROMPT).toContain('讲某一步的流程节点');
		expect(TEACHING_SYSTEM_PROMPT).toContain('每棵顶层积木');
		expect(TEACHING_SYSTEM_PROMPT).toContain('每一段代码');
		// 后果不是修辞：指到不存在的步 → 整份规格被拒；顶层不写 → 照画但不点亮。
		expect(TEACHING_SYSTEM_PROMPT).toContain('整份规格会被拒');
		expect(TEACHING_SYSTEM_PROMPT).toContain('跟不了当前步');
		// 「照那张表抄」这句话要有——表在材料里，模型得知道去哪儿看。
		expect(TEACHING_SYSTEM_PROMPT).toContain('每一步的执行路径');
	});

	/*
	 * 这一条来自一次真实的整份被拒（2026-10，输入「旋转360度」）：
	 * 任务 JSON 只有一步，模型为了讲清楚，加了一个"等旋转走完"的等待框，
	 * 并按上面那条「每个流程节点都要写 planPath」给它编了一个越界的 "2" ——
	 * 于是整份规格形状不过，三块画布全空，用户看到的是「模型给的规格形状不对」。
	 *
	 * 根因是**提示词自己自相矛盾**：示例里那个 wait 节点带着 planPath，
	 * 规则又说"每个流程节点都要写"。所以这里把两件事都钉住：
	 * ① 规则必须说清「自己加出来的讲解节点不写 planPath」；
	 * ② 示例本身必须与契约一致——那份示例 JSON 现在真的能被解析出来。
	 */
	it('提示词不自相矛盾：没对应步的框不许编 planPath，示例本身也过得了契约', () => {
		expect(TEACHING_SYSTEM_PROMPT).toContain('没有对应步的框，一个字都不要写 planPath');
		// 示例里那个 wait 节点不许再带 planPath（它就是当初教坏模型的那一行）。
		expect(TEACHING_SYSTEM_PROMPT).toContain('{"id":"n3","kind":"wait","title":"等它稳下来"}');
		expect(TEACHING_SYSTEM_PROMPT).not.toContain('"kind":"wait","title":"等 1 秒","planPath"');
		// 分支仍必须写——那是这一层放宽后唯一的硬要求，提示词里得说得出。
		expect(TEACHING_SYSTEM_PROMPT).toContain('decision 节点必须写');
	});

	it('材料与要求对得上：提示词说的字段名就是契约里的字段名', async () => {
		const declaration = (await declarationOf());
		const material = teachingMaterialOf(declaration, ROBOFRAME_SO101_CATALOG, '{}', planPathsOf(declaration));
		// 材料里那一块的表头与提示词里指的那一块是同一句（模型照着找得到）。
		expect(material).toContain('【每一步的执行路径（写 planPath 时照这张表抄，一个字都别改）】');
		expect(TEACHING_SYSTEM_PROMPT).toContain('每一步的执行路径');
	});
});

describe('这一次通话的请求体', () => {
	it('max_tokens 覆写成 4096（512 装不下一棵块树 + 一张图 + 一段代码）', async () => {
		let body: Record<string, unknown> = {};
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse(sseForSpec());
		}) as unknown as typeof fetch;

		const result = await generateTeachingSpec({
			endpoint: '/llm',
			declaration: (await declarationOf()),
			catalog: ROBOFRAME_SO101_CATALOG,
			deviceRef: 'so101_sim',
			formatRef: 'skill_plan',
			declarationText: '{}',
			fetchImpl,
		});

		expect(result.ok).toBe(true);
		expect(body['max_tokens']).toBe(4096);
		// 传输那一层仍是共享请求体：流式 + 关掉思考 + json_object。
		expect(body['stream']).toBe(true);
		expect(body['reasoning_effort']).toBe('none');
		expect(body['response_format']).toEqual({ type: 'json_object' });
		const messages = body['messages'] as { role: string; content: string }[];
		expect(messages[0]?.role).toBe('system');
		expect(messages[0]?.content).toContain('不许一块包全部');
		// 材料在 user 那条里，且带着这台设备的目录事实。
		expect(messages[1]?.content).toContain('skill_action_name = /embodied/execute_skill');
	});

	it('一次成功的返回：解析出来就是那份规格（`code` 是分段拼出来的，不是模型写的）', async () => {
		const fetchImpl = (async () => sseResponse(sseForSpec())) as unknown as typeof fetch;
		const result = await generateTeachingSpec({
			endpoint: '/llm',
			declaration: (await declarationOf()),
			catalog: ROBOFRAME_SO101_CATALOG,
			deviceRef: 'so101_sim',
			formatRef: 'skill_plan',
			declarationText: '{}',
			fetchImpl,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spec.title).toBe(TEACHING_SPEC_FIXTURE.title);
		// `code` 不是模型交的那一份（模型只交分段），而是**拼出来的**。
		expect(result.spec.code).toBe(codeOfSegments(TEACHING_SPEC_FIXTURE.codeSegments));
		expect(result.spec.code).toBe(TEACHING_SPEC_FIXTURE.code);
		// 模型交的那份原文再过一次解析（不带声明，只判形状）：形状这一层它也过。
		expect(parseTeachingSpec(teachingSpecJson()).ok).toBe(true);
	});

	it('整段流完了但形状不过：判据是它，重试一次（attempts=2）', async () => {
		let calls = 0;
		const userMessages: string[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			calls += 1;
			const parsedBody = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
			userMessages.push(parsedBody.messages.find((message) => message.role === 'user')?.content ?? '');
			return sseResponse(sseForSpec(calls === 1 ? SINGLE_BLOCK_SPEC : TEACHING_SPEC_FIXTURE));
		}) as unknown as typeof fetch;
		const result = await generateTeachingSpec({
			endpoint: '/llm',
			declaration: (await declarationOf()),
			catalog: ROBOFRAME_SO101_CATALOG,
			deviceRef: 'so101_sim',
			formatRef: 'skill_plan',
			declarationText: '{}',
			// 判据在这儿：故意把 accept 换掉，验的是「整段流完了才判、判不过就再来一次」。
			fetchImpl,
			attempts: 2,
			wait: async () => undefined,
		});
		expect(result.ok).toBe(true);
		expect(calls).toBe(2);
		/*
		 * 第二次**带着上一次「哪儿不对」**再问一遍。
		 *
		 * 不带的话第二次只是把同一个坑再踩一次（实测：模型把 `body` 写到 `call` 上，
		 * 第二次照样这么写）——判据已经把话说清了，交回去才是真的重试。
		 */
		expect(userMessages[0]).not.toContain('上一次那一份没通过');
		expect(userMessages[1]).toContain('上一次那一份没通过');
		expect(userMessages[1]).toContain('一块包全部');
	});
});

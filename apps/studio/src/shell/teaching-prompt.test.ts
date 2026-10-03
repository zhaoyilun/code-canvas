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
import { loadSampleTask, useStudioDocument } from '../state/document';
import { setSelectedDevice } from './devices';
import { TEACHING_SYSTEM_PROMPT, teachingMaterialOf } from './teaching-prompt';
import { generateTeachingSpec } from './teaching-generation';
import { sseResponse, sseForSpec, TEACHING_SPEC_FIXTURE } from '../state/__fixtures__/teaching-spec';

const declarationOf = () => {
	setSelectedDevice('so101_sim');
	expect(loadSampleTask()).toBe(true);
	const declaration = useStudioDocument().declaration.value;
	if (declaration === null) throw new Error('样例任务没灌进来');
	return declaration;
};

/** 材料里那一段「技能清单」的行（`- ref（label）：…`）。 */
const skillLines = (material: string): readonly string[] => {
	const section = material.split('【技能清单（目录原文，技能名只能从这里来）】')[1] ?? '';
	return (section.split('\n【')[0] ?? '').split('\n').filter((line) => line.startsWith('- '));
};

describe('材料由目录现生成', () => {
	it('技能清单的条数就是目录里技能的条数，名字逐字来自目录', () => {
		const material = teachingMaterialOf(declarationOf(), ROBOFRAME_SO101_CATALOG, '{}');
		const lines = skillLines(material);
		expect(lines).toHaveLength(ROBOFRAME_SO101_CATALOG.capabilities.length);
		for (const capability of ROBOFRAME_SO101_CATALOG.capabilities) {
			expect(lines.some((line) => line.startsWith(`- ${capability.capabilityRef}（${capability.label}）`))).toBe(true);
		}
	});

	it('改目录里一个技能的 label 与参数 → 材料跟着变（提示词不是第二份目录）', () => {
		const target = 'inspect_scene';
		const renamed: CapabilityCatalog = {
			...ROBOFRAME_SO101_CATALOG,
			capabilities: ROBOFRAME_SO101_CATALOG.capabilities.map((capability) =>
				capability.capabilityRef === target
					? { ...capability, label: '看一眼桌面（改过的）', summary: '改过的说法' }
					: capability,
			),
		};
		const material = teachingMaterialOf(declarationOf(), renamed, '{}');
		expect(material).toContain('看一眼桌面（改过的）');
		expect(material).toContain('改过的说法');
		// 技能清单那一段里不再有旧名字（任务 JSON 那段里出现的是**任务里那一步的名字**，
		// 与技能清单是两回事，所以这里只看清单那一段）。
		expect(skillLines(material).join('\n')).not.toContain('（观察桌面）');
	});

	it('新补的第一层：接口名表照上游 YAML 的键与值写进材料', () => {
		const material = teachingMaterialOf(declarationOf(), ROBOFRAME_SO101_CATALOG, '{}');
		expect(material).toContain('skill_action_name = /embodied/execute_skill');
		expect(material).toContain('primitive_action_name = /embodied/execute_primitive');
		expect(material).toContain('validate_skill_service = /embodied/validate_skill');
	});

	it('新补的第二层：原语要设备先具备哪些运行时能力（含上游那句「缺了怎么说」）', () => {
		const material = teachingMaterialOf(declarationOf(), ROBOFRAME_SO101_CATALOG, '{}');
		expect(material).toContain('要设备先具备：');
		expect(material).toContain('fresh_ee_pose（缺了的话网关说：ee pose unavailable or stale）');
	});

	it('设备事实落到这一次的取值上：观察位那个坐标是目录里的真数字', () => {
		const declaration = declarationOf();
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

	it('任务 JSON 那段就是**这一份**声明（不是重新编的一份）', () => {
		const declaration = declarationOf();
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

describe('这一次通话的请求体', () => {
	it('max_tokens 覆写成 4096（512 装不下一棵块树 + 一张图 + 一段代码）', async () => {
		let body: Record<string, unknown> = {};
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sseResponse(sseForSpec());
		}) as unknown as typeof fetch;

		const result = await generateTeachingSpec({
			endpoint: '/llm',
			declaration: declarationOf(),
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

	it('一次成功的返回：解析出来就是那份规格', async () => {
		const fetchImpl = (async () => sseResponse(sseForSpec())) as unknown as typeof fetch;
		const result = await generateTeachingSpec({
			endpoint: '/llm',
			declaration: declarationOf(),
			catalog: ROBOFRAME_SO101_CATALOG,
			deviceRef: 'so101_sim',
			formatRef: 'skill_plan',
			declarationText: '{}',
			fetchImpl,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.spec.title).toBe(TEACHING_SPEC_FIXTURE.title);
		expect(parseTeachingSpec(JSON.stringify(result.spec)).ok).toBe(true);
	});

	it('整段流完了但形状不过：判据是它，重试一次（attempts=2）', async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return sseResponse(sseForSpec());
		}) as unknown as typeof fetch;
		const result = await generateTeachingSpec({
			endpoint: '/llm',
			declaration: declarationOf(),
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
		expect(calls).toBe(1);
	});
});

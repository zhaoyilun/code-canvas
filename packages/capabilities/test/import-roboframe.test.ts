/**
 * 转换脚本的回归：**真的跑一遍**，不是读产物。
 *
 * 读产物只能证明「文件在」，证明不了「这份文件是脚本转出来的」——而这两件事差得很远：
 * 目录是机械转出来的这件事，只有脚本自己跑得通才算数。所以这里 `execFileSync` 跑
 * `tools/import-roboframe/import.mjs`，然后看它写了什么。
 *
 * 上游仓库（`gitcode.com/openeuler/IB_Robot`）不在本仓库里，也不该进来（那是别人的设备代码）。
 * 所以有上游时跑、没有时**跳过**并把理由打出来——不假装通过。找上游的规矩写在下面
 * `findUpstream()` 里：必须是**一份 git 克隆**（脚本要 `git rev-parse` 拿 commit 写进
 * provenance），光有几个文件的拷贝不算。
 *
 * 这里钉三件事：
 * 1. 一次调用产出**两份**目录，且产出后字节没变——也就是说仓库里那两份产物**就是**脚本的产出
 *    （脚本走样了、或有人手改了 JSON，这里都会红）；
 * 2. `pick_object` 那条是 `delegate`，接口名 `/manipulation/execute_pick`，实参是技能的参数；
 * 3. 判据是**收紧**的：既没有 `primitive_sequence`、又不是已知委托型的技能当场报错，
 *    不静默产出一条空实现——这一条用一个临时上游（同名的机器人配置，但技能故意写坏）来验。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const script = join(repoRoot, 'tools/import-roboframe/import.mjs');
const catalogDir = join(repoRoot, 'packages/capabilities/src/roboframe');

/** 本机上可能放着上游检出的地方。都没有就跳过——测试不替上游仓库占位。 */
const UPSTREAM_CANDIDATES = [
	process.env['ROBOFRAME_SRC'],
	'/tmp/ib_robot_probe',
	join(repoRoot, '..', 'IB_Robot'),
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== '');

const NEEDED_YAMLS = ['so101_single_arm.yaml', 'so101_handeye_realsense_grasp.yaml'];

/**
 * 找一份**能用的**上游：有 `.git`（脚本要 commit），且那两份机器人配置都在。
 * 少一样就换下一个——`/tmp/ib-robot-src` 那种只有几个文件的镜像会被这一关筛掉，
 * 因为拿它去跑，脚本会在 `git rev-parse` 上炸，而那不是我们要测的东西。
 */
const findUpstream = (): string | null => {
	for (const candidate of UPSTREAM_CANDIDATES) {
		if (!existsSync(join(candidate, '.git'))) continue;
		if (!NEEDED_YAMLS.every((name) => existsSync(join(candidate, 'src/robot_config/config/robots', name)))) continue;
		return candidate;
	}
	return null;
};

const upstream = findUpstream();

/** 跑脚本；返回 stdout 与 stderr（失败时也返回，由用例自己判）。 */
const runImport = (srcRoot: string, robots: string[]): { status: number; stdout: string; stderr: string } => {
	try {
		// stdio 显式写出来：`execFileSync` 默认会把子进程的 stderr 顺手漏到本进程，
		// 而这里**故意**要跑一次会失败的转换（判据的负例）——不让它把堆栈喷到测试输出里。
		const stdout = execFileSync('node', [script, srcRoot, ...robots], {
			cwd: repoRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { status: 0, stdout, stderr: '' };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
	}
};

const readCatalogFile = (file: string): { provenance: { commit: string }; catalog: unknown } =>
	JSON.parse(readFileSync(join(catalogDir, file), 'utf8'));

/**
 * 脚本会机械读的每一个文件（照 `import.mjs` 顶部那份清单）。
 *
 * 造一个「坏上游」时必须把这些都摆上：少一个，脚本会在读文件那一步就炸，
 * 而那时它还没走到我们要验的那条判据——测试就变成了在测「文件不在」。
 */
const UPSTREAM_FILES = [
	'src/skill_library/README.md',
	'src/skill_library/skill_library/gateway_policy.py',
	'src/skill_library/skill_library/resolver.py',
	'src/embodied_common/embodied_common/trajectory_templates.py',
	'src/embodied_common/embodied_common/skill_templates.py',
	'src/embodied_bringup/embodied_bringup/launch_builders/embodied.py',
];

/** 一个临时的上游 git 仓库：文件照抄真的那份，只换掉点名的那几个。 */
const brokenUpstream = (overrides: Readonly<Record<string, string>>): string => {
	const root = mkdtempSync(join(tmpdir(), 'roboframe-broken-'));
	for (const relative of UPSTREAM_FILES) {
		mkdirSync(dirname(join(root, relative)), { recursive: true });
		writeFileSync(join(root, relative), readFileSync(join(upstream ?? '', relative), 'utf8'));
	}
	for (const [relative, content] of Object.entries(overrides)) {
		mkdirSync(dirname(join(root, relative)), { recursive: true });
		writeFileSync(join(root, relative), content);
	}
	// 脚本要先 git rev-parse 才转得动——临时仓库里提交一次即可。
	const git = (args: string[]): void => {
		execFileSync('git', args, {
			cwd: root,
			stdio: 'ignore',
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 't',
				GIT_AUTHOR_EMAIL: 't@example.invalid',
				GIT_COMMITTER_NAME: 't',
				GIT_COMMITTER_EMAIL: 't@example.invalid',
			},
		});
	};
	git(['init', '--quiet']);
	git(['add', '.']);
	git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
	return root;
};

/**
 * 一份能转得动的最小机器人 YAML。`named_poses` / `execution` / 技能体由用例给——
 * 负例要验的正是「上游少了这个字段时不许编」，所以这几段必须能一处一处地拆掉。
 */
const robotYaml = (parts: {
	readonly skill: readonly string[];
	readonly namedPoses?: readonly string[];
	readonly execution?: readonly string[];
}): string =>
	[
		'robot:',
		'  name: so101_single_arm',
		'  embodied:',
		// 接口名表那五个是**必填**的（上游 YAML 里每台都有）：负例验的是别的字段缺失时不许编，
		// 所以这几行固定摆上，别让报错先撞在接口名上。
		'    task_command_topic: /embodied/task_command',
		'    status_topic: /embodied/task_status',
		'    skill_action_name: /embodied/execute_skill',
		'    primitive_action_name: /embodied/execute_primitive',
		'    validate_skill_service: /embodied/validate_skill',
		...(parts.execution === undefined ? [] : ['    execution:', ...parts.execution.map((line) => `      ${line}`)]),
		...(parts.namedPoses === undefined ? [] : ['    named_poses:', ...parts.namedPoses.map((line) => `      ${line}`)]),
		'    skill_templates:',
		...parts.skill.map((line) => `      ${line}`),
		'',
	].join('\n');

/**
 * 一份能转得动的最小技能：一条 `open_gripper`。
 * 负例要验的是「上游少了别的字段时不许编」，所以技能本身必须干净——
 * 否则报错会先撞在技能上，测试就测错了地方。
 */
const MINIMAL_SKILL = [
	'touch:',
	'  description:',
	'    summary: "A minimal skill."',
	'  capability:',
	'    parameters:',
	'      type: object',
	'      properties: {}',
	'      required: []',
	'  primitive_sequence:',
	'    - primitive_name: open_gripper',
];

/**
 * 用一份临时上游跑一次**成功**的转换，把产物交给 `inspect` 看，然后**原样写回去**。
 *
 * 为什么必须写回去：脚本的落盘路径就是仓库里那两份产物（`packages/capabilities/src/roboframe/`），
 * 成功的转换会真的覆盖它们。`finally` 里恢复，断言失败也不会把工作树留在半路。
 */
const importInto = (root: string, robots: readonly string[], inspect: (file: string) => void): void => {
	const files = robots.map((robot) => join(catalogDir, `${robot}.catalog.json`));
	const before = files.map((file) => (existsSync(file) ? readFileSync(file, 'utf8') : null));
	try {
		const run = runImport(root, [...robots]);
		expect(run.stderr).toBe('');
		expect(run.status).toBe(0);
		files.forEach(inspect);
	} finally {
		files.forEach((file, index) => {
			const original = before[index];
			if (original === null || original === undefined) rmSync(file, { force: true });
			else writeFileSync(file, original);
		});
	}
};

const maybe = upstream === null ? describe.skip : describe;

if (upstream === null) {
	// 说出来，而不是静悄悄地少跑几条：这台机器上没有上游，这几条断言这次没有生效。
	console.warn(`跳过转换脚本回归：找不到上游检出（看过 ${UPSTREAM_CANDIDATES.join('、')}）`);
}

maybe('转换脚本真的跑得通（需要一份上游 git 克隆）', () => {
	it('一次调用产出两份目录，产出与仓库里的字节一致', () => {
		const singleArm = join(catalogDir, 'so101_single_arm.catalog.json');
		const grasp = join(catalogDir, 'so101_handeye_realsense_grasp.catalog.json');
		const before = [readFileSync(singleArm, 'utf8'), readFileSync(grasp, 'utf8')];

		const run = runImport(upstream ?? '', []);

		expect(run.stderr).toBe('');
		expect(run.status).toBe(0);
		// 脚本自己说它写了哪两个文件（比"文件存在"强：文件本来就在）。
		expect(run.stdout).toContain(singleArm);
		expect(run.stdout).toContain(grasp);
		// 产出后字节没变：仓库里那两份产物**就是**脚本的产出（脚本走样/手改过 JSON 都会在这里红）。
		expect([readFileSync(singleArm, 'utf8'), readFileSync(grasp, 'utf8')]).toEqual(before);
	});

	it('两份目录的 provenance 记的是同一次上游检出', () => {
		const singleArm = readCatalogFile('so101_single_arm.catalog.json');
		const grasp = readCatalogFile('so101_handeye_realsense_grasp.catalog.json');
		expect(grasp.provenance.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(grasp.provenance.commit).toBe(singleArm.provenance.commit);
	});

	it('pick_object 那条是 delegate，接口名与实参都对', () => {
		const grasp = readCatalogFile('so101_handeye_realsense_grasp.catalog.json') as {
			catalog: { capabilities: { capabilityRef: string; implementation: unknown }[] };
		};
		const pick = grasp.catalog.capabilities.find((capability) => capability.capabilityRef === 'pick_object');
		expect(pick?.implementation).toEqual([
			{
				kind: 'delegate',
				interfaceRef: '/manipulation/execute_pick',
				arguments: { target_name: { kind: 'param', name: 'target_name' } },
			},
		]);
	});

	it('既没有 primitive_sequence、又不是已知委托型的技能：当场报错，不产出一条空实现', () => {
		// 临时上游：同名机器人（名字得在 DISPLAY_NAMES 里，否则会先撞上那一道检查），
		// 但技能故意写坏——没有 primitive_sequence，也没有 executor。
		const broken = brokenUpstream({
			'src/robot_config/config/robots/so101_single_arm.yaml': robotYaml({
				skill: [
					'oops:',
					'  description:',
					'    summary: "A skill whose implementation is nowhere."',
					'  capability:',
					'    parameters:',
					'      type: object',
					'      properties: {}',
					'      required: []',
				],
			}),
		});

		const singleArm = join(catalogDir, 'so101_single_arm.catalog.json');
		const before = readFileSync(singleArm, 'utf8');
		const run = runImport(broken, ['so101_single_arm']);

		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain('既没有 primitive_sequence');
		// 报错发生在写文件之前：仓库里那份产物不该被这次失败的转换碰过。
		expect(readFileSync(singleArm, 'utf8')).toBe(before);
	});

	it('命名位姿缺一个分量：当场报错，不补 0', () => {
		// 上游 `_pose_from_name` 会把缺的分量当 0.0 —— 那是**运行时**的兜底，
		// 不是这台设备声明过的坐标。照着它补 0，屏幕上就会出现一个上游没写过的数字。
		const broken = brokenUpstream({
			'src/robot_config/config/robots/so101_single_arm.yaml': robotYaml({
				namedPoses: ['home: {position: {x: 0.1, y: 0.2}}'],
				skill: [...MINIMAL_SKILL],
			}),
		});

		const run = runImport(broken, ['so101_single_arm']);

		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain('缺 z');
		expect(run.stderr).toContain('不补默认值');
	});

	it('上游没有 execution 段：目录里就没有 execution，一个默认值都不补', () => {
		const sparse = brokenUpstream({
			'src/robot_config/config/robots/so101_single_arm.yaml': robotYaml({
				namedPoses: ['home: {position: {x: 0.1, y: 0.2, z: 0.3}}'],
				skill: [...MINIMAL_SKILL],
			}),
		});

		importInto(sparse, ['so101_single_arm'], (file) => {
			const catalog = JSON.parse(readFileSync(file, 'utf8')).catalog;
			// 名字列表照旧，坐标表照旧有——但没有 execution 这一段。
			expect(catalog.namedPoses).toEqual(['home']);
			expect(catalog.namedPoseTargets).toEqual([{ name: 'home', position: { x: 0.1, y: 0.2, z: 0.3 } }]);
			expect('execution' in catalog).toBe(false);
			// 轨迹展开规则来自上游**代码**（不是这台设备的 YAML），所以照旧在。
			expect(catalog.trajectoryTemplates.length).toBeGreaterThan(0);
		});
	});

	it('新补的两层：接口名表按上游路径取，原语的运行时能力来自 gateway_policy', () => {
		const root = brokenUpstream({
			'src/robot_config/config/robots/so101_single_arm.yaml': robotYaml({
				namedPoses: ['home: {position: {x: 0.1, y: 0.2, z: 0.3}}'],
				execution: ['task_executor_action_name: /task_executor/execute_task_plan'],
				skill: [...MINIMAL_SKILL],
			}),
		});

		importInto(root, ['so101_single_arm'], (file) => {
			const catalog = JSON.parse(readFileSync(file, 'utf8')).catalog;
			// 五个 embodied.* 与一个 execution.*：**两处归属分开**（上游 launch builder 也是分两处读的），
			// 值逐字来自 YAML，一个都不改写。
			expect(catalog.interfaces).toEqual({
				task_command_topic: '/embodied/task_command',
				status_topic: '/embodied/task_status',
				skill_action_name: '/embodied/execute_skill',
				primitive_action_name: '/embodied/execute_primitive',
				validate_skill_service: '/embodied/validate_skill',
				task_executor_action_name: '/task_executor/execute_task_plan',
			});
			// 这份 YAML 没写 move_configuration_service：目录里就没有这一条（不补上游没写的）。
			expect('move_configuration_service' in catalog.interfaces).toBe(false);

			// 运行时能力：能力名与「缺了怎么说」都是上游 gateway_policy 的原文。
			const open = catalog.primitives.find((primitive: { primitiveRef: string }) => primitive.primitiveRef === 'open_gripper');
			expect(open.runtimeCapabilities).toEqual([
				{ name: 'validate_skill', unavailableMessage: 'validate skill service unavailable' },
				{ name: 'task_executor', unavailableMessage: 'task executor action unavailable' },
			]);
			// 上游那张表没登记的两条：这个键整个不出现——空数组与「上游没说」不是一回事。
			const moveToPose = catalog.primitives.find((primitive: { primitiveRef: string }) => primitive.primitiveRef === 'move_to_pose');
			expect('runtimeCapabilities' in moveToPose).toBe(false);
		});
	});

	it('上游缺一个必填的接口名：当场报错，不写出一份编的接口表', () => {
		const yaml = robotYaml({ skill: [...MINIMAL_SKILL] }).replace(
			'    skill_action_name: /embodied/execute_skill\n',
			'',
		);
		expect(yaml).not.toContain('skill_action_name');
		const broken = brokenUpstream({ 'src/robot_config/config/robots/so101_single_arm.yaml': yaml });

		const singleArm = join(catalogDir, 'so101_single_arm.catalog.json');
		const before = readFileSync(singleArm, 'utf8');
		const run = runImport(broken, ['so101_single_arm']);

		try {
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain('取不到接口名 embodied.skill_action_name');
			// 报错发生在写文件之前：仓库里那份产物不该被这次失败的转换碰过。
			expect(readFileSync(singleArm, 'utf8')).toBe(before);
		} finally {
			// 万一判据松了、这次转换真的写成功了，产物必须原样写回去——
			// 前面就吃过一次亏：一条本该失败的转换写成功了，把真目录盖成了 fixture 那份。
			writeFileSync(singleArm, before);
		}
	});

	it('launch builder 不再从 embodied 读那个接口名：归属对账当场报错', () => {
		// 路径表说的归属不是我们分的——上游 launch builder 从哪个变量读，那条接口就属于哪一段。
		// 把它改成从另一段读，等于上游改了口径，这时必须报错而不是照旧写着 embodied。
		const builderPath = 'src/embodied_bringup/embodied_bringup/launch_builders/embodied.py';
		const builder = readFileSync(join(upstream ?? '', builderPath), 'utf8');
		// 全部替掉：那个文件里同一处读法出现两次（executor 与另一个节点），
		// 只替一处的会漏，而漏掉的那处照样满足对账——那就变成在测「替换没生效」了。
		const mutated = builder.replaceAll(
			'"skill_action_name": embodied_config.get("skill_action_name"',
			'"skill_action_name": execution.get("skill_action_name"',
		);
		expect(mutated).not.toBe(builder);

		const broken = brokenUpstream({
			[builderPath]: mutated,
			'src/robot_config/config/robots/so101_single_arm.yaml': robotYaml({ skill: [...MINIMAL_SKILL] }),
		});
		const run = runImport(broken, ['so101_single_arm']);

		const singleArm = join(catalogDir, 'so101_single_arm.catalog.json');
		const before = readFileSync(singleArm, 'utf8');
		try {
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain('skill_action_name 在 launch builder 里不是从 embodied_config 读的');
		} finally {
			writeFileSync(singleArm, before);
		}
	});

	it('上游 resolver 不再读那个字段：登记的设备事实当场被拆穿，不静默写进目录', () => {
		// 把 `move_to_named_pose` 分支里取位姿名那一行删掉——分支（连它直接调用的函数）
		// 都不再读 `pose_name`，那张「原语落到哪条事实上」的表就与上游对不上了。
		const resolver = readFileSync(join(upstream ?? '', 'src/skill_library/skill_library/resolver.py'), 'utf8');
		const mutated = resolver.replace(
			'pose_name=_resolve_pose_name(step, target_name, place_name, named_targets),',
			'pose_name="",',
		);
		expect(mutated).not.toBe(resolver);

		const broken = brokenUpstream({
			'src/skill_library/skill_library/resolver.py': mutated,
			'src/robot_config/config/robots/so101_single_arm.yaml': robotYaml({
				namedPoses: ['home: {position: {x: 0.1, y: 0.2, z: 0.3}}'],
				skill: [...MINIMAL_SKILL],
			}),
		});

		const run = runImport(broken, ['so101_single_arm']);

		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain('poseNameArgument=pose_name');
		expect(run.stderr).toContain('对不上 resolver.py');
	});
});

// 没有上游时也要有一条**真的**断言：不然 describe.skip 之外整份文件是空的，
// 看起来像"跑过了"。这条说的是脚本文件本身在、且用法说明里写着多份配置。
describe('转换脚本本身', () => {
	it('脚本就在那儿，且用法里写了可以点名多份配置', () => {
		const source = readFileSync(script, 'utf8');
		expect(source).toContain('DEFAULT_ROBOTS');
		expect(source).toContain('ROBOFRAME_SRC=/path/to/IB_Robot');
		expect(dirname(script)).toBe(join(repoRoot, 'tools/import-roboframe'));
	});
});

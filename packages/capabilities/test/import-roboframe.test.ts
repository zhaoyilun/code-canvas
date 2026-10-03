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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
		const broken = mkdtempSync(join(tmpdir(), 'roboframe-broken-'));
		mkdirSync(join(broken, 'src/skill_library/skill_library'), { recursive: true });
		mkdirSync(join(broken, 'src/robot_config/config/robots'), { recursive: true });
		// 原语表与 gateway_policy 照抄真的那份：坏的只是那一个技能。
		writeFileSync(
			join(broken, 'src/skill_library/README.md'),
			readFileSync(join(upstream ?? '', 'src/skill_library/README.md'), 'utf8'),
		);
		writeFileSync(
			join(broken, 'src/skill_library/skill_library/gateway_policy.py'),
			readFileSync(join(upstream ?? '', 'src/skill_library/skill_library/gateway_policy.py'), 'utf8'),
		);
		writeFileSync(
			join(broken, 'src/robot_config/config/robots/so101_single_arm.yaml'),
			[
				'robot:',
				'  name: so101_single_arm',
				'  embodied:',
				'    skill_templates:',
				'      oops:',
				'        description:',
				'          summary: "A skill whose implementation is nowhere."',
				'        capability:',
				'          parameters:',
				'            type: object',
				'            properties: {}',
				'            required: []',
				'',
			].join('\n'),
		);
		// 脚本要先 git rev-parse 才转得动——临时仓库里提交一次即可。
		const git = (args: string[]): void => {
			execFileSync('git', args, {
				cwd: broken,
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

		const singleArm = join(catalogDir, 'so101_single_arm.catalog.json');
		const before = readFileSync(singleArm, 'utf8');
		const run = runImport(broken, ['so101_single_arm']);

		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain('既没有 primitive_sequence');
		// 报错发生在写文件之前：仓库里那份产物不该被这次失败的转换碰过。
		expect(readFileSync(singleArm, 'utf8')).toBe(before);
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

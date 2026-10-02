/**
 * 从上游 RoboFrame 仓库生成 SO-101 单臂的技能目录（`packages/capabilities/src/roboframe/*.json`）。
 *
 * 为什么要有这个脚本：目录里的每一个字都必须是**真的**——技能名、原语名、实参、
 * 中文别名、命名位姿，全部来自 `robot_config` 的 SSOT YAML 与 `skill_library` 的原语表。
 * 手抄一遍迟早与上游分叉，所以这里机械地转，转不动的**当场报错**，不猜。
 *
 * 用法：
 *
 * ```bash
 * ROBOFRAME_SRC=/path/to/IB_Robot node tools/import-roboframe/import.mjs
 * node tools/import-roboframe/import.mjs /path/to/IB_Robot so101_single_arm
 * ```
 *
 * 上游：`gitcode.com/openeuler/IB_Robot` 分支 `RoboFrame`。
 * 读的四个文件：
 * - `src/robot_config/config/robots/<robot>.yaml` —— 技能模板、命名位姿（SSOT）
 * - `src/skill_library/README.md` —— 允许的原语清单与中文作用（§3 表格）
 * - `src/skill_library/skill_library/gateway_policy.py` —— 原语需要哪些运行时能力
 * - `src/skill_library/skill_library/resolver.py` —— 模板字段 → 原语实参的展开规则
 *
 * 三处**翻译**（上游语义与本地契约不是一一对应，逐条写在这里，不藏在代码里）：
 * 1. `initial_gripper_state: open|closed` → 展开时在最前面插一条 `open_gripper` / `close_gripper`
 *    （照抄 `resolver.resolve_skill_primitives` 的行为，不是我们的发明）。
 * 2. `foo_from_request: true` → `{kind:'param', name:'foo'}`：取值来自任务请求，
 *    正是「同一份实现被不同参数复用」那条链。
 * 3. YAML 里的字段名就是模板层的字段名（`duration_sec`、`trajectory_template`），
 *    **不**翻成 ROS action 的 goal 字段（`primitive_duration_sec`、`joint_waypoints`）——
 *    技能作者写的是模板，教学要教的是模板这一层。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const here = dirname(new URL(import.meta.url).pathname);
const repoRoot = join(here, '..', '..');

const srcRoot = process.argv[2] ?? process.env.ROBOFRAME_SRC ?? '';
const robotName = process.argv[3] ?? 'so101_single_arm';

if (srcRoot === '') {
	console.error('缺少上游路径：ROBOFRAME_SRC=/path/to/IB_Robot node tools/import-roboframe/import.mjs');
	process.exit(2);
}

const read = (relative) => readFileSync(join(srcRoot, relative), 'utf8');

// ---------------------------------------------------------------------------
// 上游事实：原语表
// ---------------------------------------------------------------------------

/**
 * 允许的原语与它们的中文作用，读自 `src/skill_library/README.md` §3 的表格。
 * 表格是上游自己维护的「有限原语」白名单——`skill_library` 只放行这些，
 * 所以我们照它建目录，而不是照模板里出现过什么。
 */
const readPrimitiveTable = () => {
	const markdown = read('src/skill_library/README.md');
	const section = markdown.split('## 3. 当前支持的 primitive')[1];
	if (section === undefined) throw new Error('skill_library/README.md 里找不到「## 3. 当前支持的 primitive」');
	const body = section.split(/\n## /)[0] ?? '';
	const rows = [...body.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*([^|]+?)\s*\|$/gm)];
	if (rows.length === 0) throw new Error('原语表一行都没解析出来（上游改了表格格式？）');
	return rows.map((row) => ({ primitiveRef: row[1], summary: row[2] }));
};

/**
 * 每个原语的实参：**模板层**的字段名与类型。
 *
 * 这一张表是人对 `resolver.py` 的判读（哪个字段落成哪个实参），不是从代码里抠出来的——
 * 所以下面 `assertKnownArguments` 会拿模板里真实出现过的字段来对账：
 * 上游要是多出一个字段，这里立刻报错，不会静默丢掉。
 */
const PRIMITIVE_PARAMETERS = {
	move_to_named_pose: [{ name: 'pose_name', label: '命名位姿', type: 'pose' }],
	move_to_pose: [{ name: 'target_pose', label: '目标位姿（base 系）', type: 'json' }],
	move_to_configuration: [{ name: 'joint_positions', label: '关节配置', type: 'json' }],
	move_relative_ee: [
		{ name: 'motion_direction', label: '移动方向', type: 'string' },
		{ name: 'motion_distance', label: '移动距离（米）', type: 'number' },
	],
	move_to_joint_positions: [
		{ name: 'joint_positions', label: '关节目标位置', type: 'json' },
		{ name: 'duration_sec', label: '到位时间（秒）', type: 'number' },
	],
	move_through_joint_positions: [{ name: 'trajectory_template', label: '轨迹模板', type: 'json' }],
	open_gripper: [],
	close_gripper: [],
	rotate_gripper_cw: [{ name: 'motion_distance', label: '旋转角度（度）', type: 'number' }],
	rotate_gripper_ccw: [{ name: 'motion_distance', label: '旋转角度（度）', type: 'number' }],
};

/** 模板里能出现的字段：`<实参>` 本身，或 `<实参>_from_request`。 */
const assertKnownArguments = (primitiveRef, step, where) => {
	const declared = new Set((PRIMITIVE_PARAMETERS[primitiveRef] ?? []).map((item) => item.name));
	for (const key of Object.keys(step)) {
		if (key === 'primitive_name') continue;
		const base = key.endsWith('_from_request') ? key.slice(0, -'_from_request'.length) : key;
		if (!declared.has(base)) {
			throw new Error(`${where}：原语 ${primitiveRef} 出现未知字段 ${key}，参数表要跟着上游改`);
		}
	}
};

/**
 * 运行时能力要求，读自 `gateway_policy.py` 的 `_PRIMITIVE_CAPABILITY_MAP`。
 * 只用来做**交叉校验**：模板里用到的原语必须在这张表里（或者在上游 README 的白名单里），
 * 否则说明我们认错了仓库版本。
 */
const readCapabilityMap = () => {
	const source = read('src/skill_library/skill_library/gateway_policy.py');
	const body = source.split('_PRIMITIVE_CAPABILITY_MAP')[1] ?? '';
	const names = [...body.matchAll(/^\s{4}"([a-z_]+)":/gm)].map((match) => match[1]);
	if (names.length === 0) throw new Error('gateway_policy.py 里解析不出 _PRIMITIVE_CAPABILITY_MAP');
	return new Set(names);
};

// ---------------------------------------------------------------------------
// 上游事实：技能模板
// ---------------------------------------------------------------------------

/** 一个模板字段 → 一个实参。`*_from_request` 落成参数引用，其余落成字面量。 */
const argumentOf = (step, name, capabilityParameters, where) => {
	if (step[`${name}_from_request`] === true) {
		if (!capabilityParameters.includes(name)) {
			throw new Error(`${where}：${name}_from_request 取了任务参数，但这个技能的 parameters 里没有 ${name}`);
		}
		return { kind: 'param', name };
	}
	if (!(name in step)) return undefined;
	return { kind: 'literal', value: step[name] };
};

const statementsOf = (skillName, template, capabilityParameters) => {
	const statements = [];
	const where = `技能 ${skillName}`;

	// 展开规则 1：夹爪归一化（上游 resolver 在这里插一条，不是我们加的）。
	const initial = String(template.initial_gripper_state ?? '').trim().toLowerCase();
	if (initial === 'open') statements.push({ kind: 'call', primitiveRef: 'open_gripper', arguments: {} });
	else if (initial === 'closed') statements.push({ kind: 'call', primitiveRef: 'close_gripper', arguments: {} });
	else if (initial !== '' && initial !== 'hold' && initial !== 'none') {
		throw new Error(`${where}：initial_gripper_state 取值 ${initial} 上游不认`);
	}

	for (const [index, step] of (template.primitive_sequence ?? []).entries()) {
		const primitiveRef = step.primitive_name;
		const stepWhere = `${where} 第 ${index + 1} 步`;
		assertKnownArguments(primitiveRef, step, stepWhere);
		const parameters = PRIMITIVE_PARAMETERS[primitiveRef];
		if (parameters === undefined) throw new Error(`${stepWhere}：原语 ${primitiveRef} 不在允许表里`);

		const args = {};
		for (const parameter of parameters) {
			const argument = argumentOf(step, parameter.name, capabilityParameters, stepWhere);
			if (argument !== undefined) args[parameter.name] = argument;
		}
		statements.push({ kind: 'call', primitiveRef, arguments: args });
	}

	if (statements.length === 0) throw new Error(`${where}：展开后一条语句都没有`);
	return statements;
};

/** 能力参数：上游给的是 JSON Schema 片段，这里取我们认得的三种类型。 */
const parametersOf = (skillName, schema) => {
	const properties = schema?.properties ?? {};
	const types = { number: 'number', string: 'string', boolean: 'boolean' };
	return Object.entries(properties).map(([name, spec]) => {
		const type = types[spec?.type];
		if (type === undefined) throw new Error(`技能 ${skillName}：参数 ${name} 的类型 ${spec?.type} 不认识`);
		return { name, label: spec?.description ?? name, type };
	});
};

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

const primitiveTable = readPrimitiveTable();
const capabilityMap = readCapabilityMap();
const robot = parse(read(join('src/robot_config/config/robots', `${robotName}.yaml`))).robot;
const skills = robot.embodied.skill_templates;

const primitives = primitiveTable.map(({ primitiveRef, summary }) => {
	const parameters = PRIMITIVE_PARAMETERS[primitiveRef];
	if (parameters === undefined) {
		throw new Error(`README 列出的原语 ${primitiveRef} 没有参数表——上游加了新原语，参数表要跟着改`);
	}
	return { primitiveRef, label: summary.split('，')[0] ?? summary, summary, parameters };
});

const capabilities = Object.entries(skills).map(([name, template]) => {
	const parameters = parametersOf(name, template.capability?.parameters);
	const aliases = template.description?.aliases_zh ?? [];
	const label = aliases[0] ?? name;
	if (label.length > 64) throw new Error(`技能 ${name} 的 label「${label}」超出 64 字`);
	return {
		capabilityRef: name,
		label,
		summary: template.description?.summary ?? template.capability?.summary,
		kind: 'skill',
		parameters,
		implementation: statementsOf(name, template, parameters.map((parameter) => parameter.name)),
	};
});

// 对账：模板里出现过的原语必须在 gateway_policy 的表里或 README 的白名单里。
const used = new Set(capabilities.flatMap((c) => c.implementation.map((s) => s.primitiveRef)));
for (const primitiveRef of used) {
	if (!primitives.some((primitive) => primitive.primitiveRef === primitiveRef)) {
		throw new Error(`模板用到原语 ${primitiveRef}，但它不在 README 的白名单里`);
	}
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcRoot }).toString().trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: srcRoot }).toString().trim();

const output = {
	provenance: {
		upstream: 'https://gitcode.com/openeuler/IB_Robot',
		branch,
		commit,
		robotConfig: `src/robot_config/config/robots/${robotName}.yaml`,
		generatedBy: 'tools/import-roboframe/import.mjs',
	},
	catalog: {
		catalogRef: `roboframe_${robotName}`,
		displayName:
			robotName === 'so101_single_arm' ? 'SO-101 单臂（RoboFrame 技能库）' : `${robotName}（RoboFrame 技能库）`,
		revisionRef: `roboframe-${robotName}-${commit.slice(0, 8)}`,
		namedPoses: Object.keys(robot.embodied.named_poses ?? {}),
		primitives,
		capabilities,
	},
};

const outDir = join(repoRoot, 'packages/capabilities/src/roboframe');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${robotName}.catalog.json`);
writeFileSync(outFile, `${JSON.stringify(output, null, '\t')}\n`);

console.log(`上游 ${branch}@${commit.slice(0, 8)}`);
console.log(`${primitives.length} 个原语（白名单），${capabilities.length} 个技能`);
console.log(
	`用到 ${used.size} 个原语：${[...used].sort().join(', ')}${
		[...used].every((name) => capabilityMap.has(name)) ? '' : '（有原语不在 gateway_policy 表里，查一下）'
	}`,
);
console.log(`→ ${outFile}`);

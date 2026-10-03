/**
 * 从上游 RoboFrame 仓库生成技能目录（`packages/capabilities/src/roboframe/*.catalog.json`）。
 *
 * 为什么要有这个脚本：目录里的每一个字都必须是**真的**——技能名、原语名、实参、
 * 中文别名、命名位姿，全部来自 `robot_config` 的 SSOT YAML 与 `skill_library` 的原语表。
 * 手抄一遍迟早与上游分叉，所以这里机械地转，转不动的**当场报错**，不猜。
 *
 * 用法：
 *
 * ```bash
 * ROBOFRAME_SRC=/path/to/IB_Robot node tools/import-roboframe/import.mjs
 * node tools/import-roboframe/import.mjs /path/to/IB_Robot so101_single_arm so101_handeye_realsense_grasp
 * ```
 *
 * 一次转**多份**配置：不点名就转 `DEFAULT_ROBOTS` 那两台，每台一份
 * `packages/capabilities/src/roboframe/<robot>.catalog.json`。多份共用一个 `srcRoot`，
 * 所以它们的 `provenance.commit` 必然相同——目录的出处是仓库级的，不是文件级的。
 * 上游是个 git 仓库，脚本要 `git rev-parse` 拿 commit，所以 `srcRoot` 得是**克隆**，
 * 不是几个文件的拷贝。
 *
 * 上游：`gitcode.com/openeuler/IB_Robot` 分支 `RoboFrame`。
 * 机械读的三个文件：
 * - `src/robot_config/config/robots/<robot>.yaml` —— 技能模板、命名位姿（SSOT）
 * - `src/skill_library/README.md` —— 允许的原语清单与中文作用（§3 表格）
 * - `src/skill_library/skill_library/gateway_policy.py` —— 原语需要哪些运行时能力
 * 另有一份是**人读的**（不解析）：`src/skill_library/skill_library/resolver.py`
 * ——「模板字段 → 原语实参」的展开规则在 `PRIMITIVE_ARGUMENTS` 那张表里，依据写在表头上。
 *
 * 四处**翻译**（上游语义与本地契约不是一一对应，逐条写在这里，不藏在代码里）：
 * 1. `initial_gripper_state: open|closed` → 展开时在最前面插一条 `open_gripper` / `close_gripper`
 *    （照抄 `resolver.resolve_skill_primitives` 的行为，不是我们的发明）。
 * 2. `foo_from_request: true` → `{kind:'param', name:'foo'}`：取值来自任务请求，
 *    正是「同一份实现被不同参数复用」那条链。
 * 3. YAML 里的字段名就是模板层的字段名（`duration_sec`、`trajectory_template`），
 *    **不**翻成 ROS action 的 goal 字段（`primitive_duration_sec`、`joint_waypoints`）——
 *    技能作者写的是模板，教学要教的是模板这一层。
 * 4. **空 `primitive_sequence` 的技能**（实现在执行侧）→ 一条 `delegate`，只认「已知的委托型」：
 *    模板声明了 `executor`，且这个 executor 在 `DELEGATE_EXECUTORS` 里对得上一条取接口名的路径。
 *    `interfaceRef` 取机器人配置里那个执行器的 action 名（`robot.grasp_execution.action_name`
 *    = `/manipulation/execute_pick`），`arguments` 由这个技能 `capability.parameters` 声明的
 *    参数逐个映射成 `{kind:'param', name}`（`pick_object` 就是 `target_name` 一个）。
 *    依据是上游自己的说法：`skill_library/README.md` §4 末尾写着「`pick_object` 不展开静态
 *    `named_targets` 位姿，而是**委托给** `/manipulation/execute_pick`。GraspGen 在运行时生成
 *    动态 6-DOF 候选」；同一份 §9 的参数表把 `pick_action_name` 直接叫作「**委托型**抓取技能
 *    action 名」；`ibrobot_msgs/README.md` 的 `PickObject.action` 段给出这个接口的默认路径与
 *    `target_query`（「运行时视觉文本查询，不是静态 `named_targets` 键」）。
 *    实参的键仍用**技能参数的名字**（`target_name`），不翻成 goal 字段名（`target_query`）——
 *    与第 3 条同一个理由。
 *    判据是**收紧**的：既没有 `primitive_sequence`、又不属于已知委托型的技能当场报错，
 *    不静默产出一条空实现，也不猜一条 delegate。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const here = dirname(new URL(import.meta.url).pathname);
const repoRoot = join(here, '..', '..');

/** 不点名时转哪几台。写在这里而不是"扫描整个 robots 目录"：默认输出要是**定下来的**。 */
const DEFAULT_ROBOTS = ['so101_single_arm', 'so101_handeye_realsense_grasp'];

/**
 * 面向人的一句话。上游 YAML 里没有这个字段（`robot.name` 是机器名，`displayName` 是给人看的），
 * 所以这是人写的——正因为是人写的，它必须**列在这里**：没列出过的机器名当场报错，不猜。
 */
const DISPLAY_NAMES = {
	so101_single_arm: 'SO-101 单臂（RoboFrame 技能库）',
	so101_handeye_realsense_grasp: 'SO-101 抓取（腕装 RealSense，RoboFrame 技能库）',
};

const srcRoot = process.argv[2] ?? process.env.ROBOFRAME_SRC ?? '';
const robotNames = process.argv.slice(3).length > 0 ? process.argv.slice(3) : DEFAULT_ROBOTS;

if (srcRoot === '') {
	console.error(
		'缺少上游路径：ROBOFRAME_SRC=/path/to/IB_Robot node tools/import-roboframe/import.mjs [robot...]',
	);
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

/**
 * 「实现在执行侧」的技能：模板声明 `executor`，这张表说那个执行器的**接口名从哪来**。
 *
 * 表里的两条都是上游的事实，不是我们的约定：`pick_object` 在 YAML 里写着
 * `executor: grasp_pipeline`（`manipulation_execution/README.md`：「`pick_object` 负责把技能入口
 * 委托给本执行器」），`grasp_execution.action_name` 是这台配置里那个执行器的 action 名。
 * 取不到就报错——编一个接口名出来，等于凭空造一个执行侧并不存在的东西。
 */
const DELEGATE_EXECUTORS = {
	grasp_pipeline: {
		enabledPath: ['grasp_execution', 'enabled'],
		actionNamePath: ['grasp_execution', 'action_name'],
	},
};

/** 按路径取值；中途缺一层就返回 undefined（缺哪一层由调用方报错，报错信息里带路径）。 */
const readPath = (root, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), root);

/** 已知的委托型 → 一条 `delegate`。未知的 executor 当场报错：宁可不转，也不猜。 */
const delegateStatementsOf = (skillName, template, robot, capabilityParameters) => {
	const where = `技能 ${skillName}`;
	const executor = template.executor;
	const known = DELEGATE_EXECUTORS[executor];
	if (known === undefined) {
		throw new Error(
			`${where}：声明了 executor=${executor}，但它不是已知的委托型（已知：${Object.keys(DELEGATE_EXECUTORS).join('、')}）——上游的新委托型要登记进 DELEGATE_EXECUTORS，才谈得上接口名从哪来`,
		);
	}
	// `enabled: false` 意味着这个执行器在这台机器上不跑：此时把技能转成 delegate，
	// 等于交付一条根本执行不了的实现。
	if (readPath(robot, known.enabledPath) !== true) {
		throw new Error(
			`${where}：executor=${executor} 对应的执行器在这台配置里没打开（${known.enabledPath.join('.')}）`,
		);
	}
	const interfaceRef = readPath(robot, known.actionNamePath);
	if (typeof interfaceRef !== 'string' || interfaceRef === '') {
		throw new Error(`${where}：取不到执行器接口名（${known.actionNamePath.join('.')}）`);
	}
	// 上游 `required_args` 说必须显式传的参数，得在这个技能声明的 parameters 里——
	// 否则下面「按声明的参数逐个映射」会把上游认为必填的东西漏掉。
	for (const name of template.required_args ?? []) {
		if (!capabilityParameters.includes(name)) {
			throw new Error(`${where}：required_args 里的 ${name} 不在这个技能声明的 parameters 里`);
		}
	}
	// arguments：这个技能**声明的**参数逐个映射成参数引用。委托不等于「没有参数」——
	// 取值由任务请求给、由执行侧解释（`target_name` 在上游就是运行时视觉文本查询）。
	const args = {};
	for (const name of capabilityParameters) args[name] = { kind: 'param', name };
	return [{ kind: 'delegate', interfaceRef, arguments: args }];
};

/**
 * 一个技能的实现。
 *
 * 判据在这里收紧：`primitive_sequence` 空的技能，**只有**已知的委托型能过；其余当场报错。
 * 早先只有末尾一句「展开后一条语句都没有」，而它是可以绕过的——`initial_gripper_state`
 * 会先插一条夹爪语句，于是「没有实现」的技能照样转得出来，只是那条实现是编的。
 */
const statementsOf = (skillName, template, robot, capabilityParameters) => {
	const where = `技能 ${skillName}`;

	// 空序列的判据**在这里**，不在末尾。末尾那句「展开后一条语句都没有」是绕得过去的：
	// `initial_gripper_state` 会先插一条夹爪语句，于是"没有实现"的技能照样转得出来，
	// 只是那条实现是编的。所以先判空、再展开。
	const sequence = Array.isArray(template.primitive_sequence) ? template.primitive_sequence : [];
	const isDelegate = template.executor !== undefined;
	if (sequence.length === 0 && !isDelegate) {
		throw new Error(
			`${where}：既没有 primitive_sequence，也不是已知的委托型——实现在别处的技能要在 DELEGATE_EXECUTORS 里登记，不能静默转成空实现`,
		);
	}
	if (sequence.length > 0 && isDelegate) {
		throw new Error(
			`${where}：既给了 primitive_sequence 又声明 executor=${template.executor}，哪个才是实现说不清`,
		);
	}
	if (isDelegate) return delegateStatementsOf(skillName, template, robot, capabilityParameters);

	const statements = [];

	// 展开规则 1：夹爪归一化（上游 resolver 在这里插一条，不是我们加的）。
	const initial = String(template.initial_gripper_state ?? '').trim().toLowerCase();
	if (initial === 'open') statements.push({ kind: 'call', primitiveRef: 'open_gripper', arguments: {} });
	else if (initial === 'closed') statements.push({ kind: 'call', primitiveRef: 'close_gripper', arguments: {} });
	else if (initial !== '' && initial !== 'hold' && initial !== 'none') {
		throw new Error(`${where}：initial_gripper_state 取值 ${initial} 上游不认`);
	}

	for (const [index, step] of sequence.entries()) {
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

	// 上面的判据已经保证序列非空；这一句是防线，防止判据被改松之后悄悄放过空实现。
	if (statements.length === 0) throw new Error(`${where}：展开后一条语句都没有`);
	return statements;
};

/**
 * 能力参数：上游给的是 JSON Schema 片段。
 *
 * 除了类型，还要把上游**写着的东西**带过来——`unit`、`required`。
 * 早先这里只取了类型，于是「米 / 度」这种单位在界面上丢了，
 * 而「这个参数必填」这条约束也没了，缺参数只能含糊地报一句提醒。
 * 判据在上游，核心不自己发明。
 */
const parametersOf = (skillName, schema) => {
	const properties = schema?.properties ?? {};
	const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
	const types = { number: 'number', string: 'string', boolean: 'boolean' };
	return Object.entries(properties).map(([name, spec]) => {
		const type = types[spec?.type];
		if (type === undefined) throw new Error(`技能 ${skillName}：参数 ${name} 的类型 ${spec?.type} 不认识`);
		return {
			name,
			label: spec?.description ?? name,
			type,
			...(typeof spec?.unit === 'string' && spec.unit !== '' ? { unit: spec.unit } : {}),
			...(required.has(name) ? { required: true } : {}),
		};
	});
};

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

const primitiveTable = readPrimitiveTable();
const capabilityMap = readCapabilityMap();

const primitives = primitiveTable.map(({ primitiveRef, summary }) => {
	const parameters = PRIMITIVE_PARAMETERS[primitiveRef];
	if (parameters === undefined) {
		throw new Error(`README 列出的原语 ${primitiveRef} 没有参数表——上游加了新原语，参数表要跟着改`);
	}
	return { primitiveRef, label: summary.split('，')[0] ?? summary, summary, parameters };
});

/**
 * 语句树里用到哪些原语：递归走（含 if 分支、赋值右值、实参里嵌的表达式）。
 *
 * 早先只看顶层语句的 `primitiveRef`——不动，是因为那时候的模板只有顶层调用。
 * 现在有了 `delegate`：它的 `interfaceRef` **不是原语**（实现在执行侧），
 * 要是照旧按 `primitiveRef` 取，会往对账集合里塞一个 `undefined`。
 */
const primitivesUsedBy = (statements) => {
	const used = new Set();
	const walkExpression = (expression) => {
		if (expression === null || typeof expression !== 'object' || Array.isArray(expression)) return;
		if (expression.kind === 'call') {
			used.add(expression.primitiveRef);
			Object.values(expression.arguments ?? {}).forEach(walkExpression);
		}
		if (expression.kind === 'binary') {
			walkExpression(expression.left);
			walkExpression(expression.right);
		}
		if (expression.kind === 'unary') walkExpression(expression.value);
	};
	const walkStatement = (statement) => {
		if (statement.kind === 'call') used.add(statement.primitiveRef);
		if (statement.kind === 'set') walkExpression(statement.value);
		if (statement.kind === 'if') {
			walkExpression(statement.condition);
			statement.then.forEach(walkStatement);
			(statement.else ?? []).forEach(walkStatement);
		}
		if (statement.kind === 'delegate') Object.values(statement.arguments).forEach(walkExpression);
	};
	statements.forEach(walkStatement);
	return used;
};

/** 一次转一台：读它的 YAML，转出它的目录，落一个文件。 */
const buildCatalog = (robotName) => {
	const displayName = DISPLAY_NAMES[robotName];
	if (displayName === undefined) {
		throw new Error(`机器人 ${robotName} 没有面向人的名字（DISPLAY_NAMES）——加一台设备要顺手写一句人话，不猜`);
	}
	const robot = parse(read(join('src/robot_config/config/robots', `${robotName}.yaml`))).robot;
	const skills = robot.embodied.skill_templates;
	if (skills === undefined) throw new Error(`${robotName} 的 YAML 里没有 embodied.skill_templates`);

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
			implementation: statementsOf(name, template, robot, parameters.map((parameter) => parameter.name)),
		};
	});

	// 对账 1：模板里出现过的原语必须在 README 的白名单里（顺带核 gateway_policy 那张表）。
	const used = new Set(capabilities.flatMap((capability) => [...primitivesUsedBy(capability.implementation)]));
	for (const primitiveRef of used) {
		if (!primitives.some((primitive) => primitive.primitiveRef === primitiveRef)) {
			throw new Error(`模板用到原语 ${primitiveRef}，但它不在 README 的白名单里`);
		}
	}

	// 对账 2：委托的接口名**不许**混进白名单。`catalog.primitives` 是上游 `skill_library`
	// 的那十个原语；`/manipulation/execute_pick` 是执行侧的接口，两回事。
	for (const capability of capabilities) {
		for (const statement of capability.implementation) {
			if (statement.kind !== 'delegate') continue;
			if (primitives.some((primitive) => primitive.primitiveRef === statement.interfaceRef)) {
				throw new Error(`${capability.capabilityRef} 的 interfaceRef ${statement.interfaceRef} 混进了原语白名单`);
			}
		}
	}

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
			robotName,
			displayName,
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

	const delegates = capabilities
		.flatMap((capability) => capability.implementation)
		.filter((statement) => statement.kind === 'delegate');
	console.log(`上游 ${branch}@${commit.slice(0, 8)} · ${robotName}`);
	console.log(
		`  ${primitives.length} 个原语（白名单），${capabilities.length} 个技能（其中 ${delegates.length} 条委托：${
			delegates.map((statement) => `${statement.interfaceRef}`).join('、') || '无'
		}）`,
	);
	console.log(
		`  用到 ${used.size} 个原语：${[...used].sort().join(', ')}${
			[...used].every((name) => capabilityMap.has(name)) ? '' : '（有原语不在 gateway_policy 表里，查一下）'
		}`,
	);
	console.log(`  → ${outFile}`);
};

// commit 是**仓库级**的：多份目录同源同版本，出处必须一致，所以在这里取一次。
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcRoot }).toString().trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: srcRoot }).toString().trim();

for (const robotName of robotNames) buildCatalog(robotName);

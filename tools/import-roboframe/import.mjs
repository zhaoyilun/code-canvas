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
 * 机械读的文件：
 * - `src/robot_config/config/robots/<robot>.yaml` —— 技能模板、命名位姿、执行量（SSOT）
 * - `src/skill_library/README.md` —— 允许的原语清单与中文作用（§3 表格）
 * - `src/skill_library/skill_library/gateway_policy.py` —— 原语需要哪些运行时能力
 *   （`_PRIMITIVE_CAPABILITY_MAP` × `_CAPABILITY_ORDER` × `_CAPABILITY_UNAVAILABLE_MESSAGES`
 *   三面对账，见 `readRuntimeCapabilities`）
 * - `src/embodied_bringup/embodied_bringup/launch_builders/embodied.py` —— 接口名表的归属对账：
 *   机器人 YAML 里那几个名字，上游 launch builder 是从 `embodied_config` 还是 `execution` 读的
 *   （见 `INTERFACE_FIELDS` 与 `assertInterfacesMatchLaunchBuilder`）
 * - `src/skill_library/skill_library/resolver.py` —— 「模板字段 → 原语实参」的展开规则
 *   （`PRIMITIVE_ARGUMENTS` 那张表、`direction_to_delta`、夹爪开合位的来源），
 *   以及每条原语**落到哪条设备事实上**（见下面的 `PRIMITIVE_DEVICE_FACTS`，逐条对着这个文件核）
 * - `src/embodied_common/embodied_common/trajectory_templates.py` —— 轨迹模板怎么展开成路点
 *   （`expand_trajectory_template` 的分派表 + 两个生成器读哪些字段、缺省是多少）
 * - `src/embodied_common/embodied_common/skill_templates.py` —— `DEFAULT_WAYPOINT_DURATION_SEC`
 *   与「模板字段 → 步骤字段 → 缺省」那条解析顺序
 *
 * 轨迹模板那条规则**不是人读的**：字段名与缺省值从 `trajectory_templates.py` 里抠出来，
 * 抠不出当场报错（见 `readTrajectoryRules`）——「照上游抄」这件事要能被执行面证明。
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
 * 5. **设备事实**（`namedPoseTargets` / `execution` / `trajectoryTemplates` /
 *    `primitiveSpec.deviceFacts`）是**照搬**，不是翻译：上游写着的数字直接进目录，
 *    上游没写的字段一个不补。为什么要有这一层——模板里那条孤零零的
 *    `move_to_named_pose(pose_name="observe_table")` 落到哪个坐标上，上游写着，我们得说出来。
 *    轨迹模板展开成多少拍是**算**出来的（上游两个生成器是嵌套的两层循环：
 *    `for _ in range(repeat_count): for index in range(active_waypoint_count)`，所以是乘法；
 *    `wave_dance_v1` 末尾再补 `zero_hold_count` 拍静止）——规则的字段名与缺省值从上游代码抠，
 *    拍数与秒数才是乘积。认不出的模板类型**什么都不说**，不猜。
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
 * 一条原语的一次调用**落到设备的哪条事实上**，以及从哪个实参取值。
 *
 * 同样是人对 `resolver.py` 的判读，所以下面 `assertDeviceFactsMatchResolver` 会把每一条
 * 拿上游源码逐条核一遍：原语名不在 resolver 的分派里、或者那个分支根本不读我们说的那个字段，
 * 当场报错。「登记一条事实」这件事也不许靠记忆。
 */
const PRIMITIVE_DEVICE_FACTS = {
	move_to_named_pose: { poseNameArgument: 'pose_name' },
	move_relative_ee: { directionArgument: 'motion_direction' },
	move_through_joint_positions: { trajectoryArgument: 'trajectory_template' },
	open_gripper: { gripperPosition: 'open' },
	close_gripper: { gripperPosition: 'closed' },
};

/** 事实里那三个「哪个实参」的键名（核 resolver 时按它们去问）。 */
const ARGUMENT_FACT_KEYS = ['poseNameArgument', 'directionArgument', 'trajectoryArgument'];

/**
 * 把 `resolver.py` 里每个原语分支的代码切出来。
 *
 * 两种分派写法都要认：`if primitive_name == "x":` 与 `if primitive_name in {"x", "y"}:`。
 * 切不出来就报错——这张表要是核不上源码，「照上游抄」就只是一句话。
 */
const readResolverBranches = () => {
	const source = read('src/skill_library/skill_library/resolver.py');
	const markers = [...source.matchAll(/^ {8}if primitive_name (?:== "([a-z_]+)"|in \{([^}]+)\}):$/gm)];
	if (markers.length === 0) throw new Error('resolver.py 里解析不出 primitive_name 的分派分支');
	const branches = new Map();
	markers.forEach((marker, index) => {
		const body = source.slice(marker.index, markers[index + 1]?.index ?? source.length);
		const names =
			marker[1] !== undefined ? [marker[1]] : [...marker[2].matchAll(/"([a-z_]+)"/g)].map((item) => item[1]);
		for (const name of names) branches.set(name, body);
	});
	return branches;
};

/**
 * 把一个 Python 文件里每个顶层函数的名字与函数体切出来（按 `^def ` 切）。
 * 只用来「顺着分支往下看一眼」，不解析语法。
 */
const readPythonFunctions = (source) => {
	const markers = [...source.matchAll(/^def ([a-z_][a-z0-9_]*)\(/gm)];
	const functions = new Map();
	markers.forEach((marker, index) => {
		functions.set(marker[1], source.slice(marker.index, markers[index + 1]?.index ?? source.length));
	});
	if (functions.size === 0) throw new Error('这个 Python 文件里一个顶层函数都没切出来（上游改了写法？）');
	return functions;
};

/** 表 vs 上游源码：逐条核。对不上说明我们记错了上游——报错，不猜。 */
const assertDeviceFactsMatchResolver = (branches) => {
	const functions = readPythonFunctions(read('src/skill_library/skill_library/resolver.py'));

	/**
	 * 这个分支读不读那个字段。
	 *
	 * 分支里读不到时**再看一层它直接调用的函数**：`move_to_named_pose` 的 `pose_name`
	 * 就是 `_resolve_pose_name(step, …)` 里读的，不是分支自己读的。只认一层——
	 * 再往下就不是「这条原语读这个字段」，而是「这个工具函数碰巧也读」了。
	 */
	const readsArgument = (branch, argument) => {
		if (branch.includes(`step.get("${argument}"`)) return true;
		for (const call of branch.matchAll(/([a-z_][a-z0-9_]*)\(/g)) {
			const body = functions.get(call[1]);
			if (body !== undefined && body.includes(`step.get("${argument}"`)) return true;
		}
		return false;
	};

	for (const [primitiveRef, facts] of Object.entries(PRIMITIVE_DEVICE_FACTS)) {
		const branch = branches.get(primitiveRef);
		if (branch === undefined) {
			throw new Error(
				`原语 ${primitiveRef} 登记了设备事实，但 resolver.py 里没有它的分派分支——上游换了原语名？`,
			);
		}
		for (const key of ARGUMENT_FACT_KEYS) {
			const argument = facts[key];
			if (argument === undefined) continue;
			if (facts.trajectoryArgument !== undefined && key === 'trajectoryArgument') {
				// 轨迹模板不在 resolver 里展开：skill_templates.py 调 expand_trajectory_template 那一侧才是展开点。
				const expansion = read('src/embodied_common/embodied_common/skill_templates.py');
				if (!expansion.includes(`step.get("${argument}")`)) {
					throw new Error(`原语 ${primitiveRef} 的 ${argument} 在 skill_templates.py 里找不到展开点`);
				}
				continue;
			}
			if (!readsArgument(branch, argument)) {
				throw new Error(
					`原语 ${primitiveRef} 的 ${key}=${argument} 对不上 resolver.py：那个分支（连它直接调用的函数）都不读 ${argument}`,
				);
			}
		}
		if (facts.gripperPosition !== undefined) {
			const expected = facts.gripperPosition === 'open' ? 'open_position' : 'closed_position';
			if (!branch.includes(expected)) {
				throw new Error(`原语 ${primitiveRef} 在 resolver.py 的分支里没有 ${expected}——夹爪到位值不是从那儿来的`);
			}
		}
	}
};

/**
 * 轨迹模板的展开规则：从上游代码里抠出字段名与缺省值。
 *
 * 上游那个文件是**代码**，这里是把它摊成数据。三件事都从源码取，抠不出就报错：
 * 1. 类型名 → 生成函数（`expand_trajectory_template` 的分派表）；
 * 2. 每个生成函数读哪几个整数字段、缺省多少（`int(template.get("…", N))`）；
 * 3. 每拍时长的字段名与缺省值（`skill_templates.py` 的 `DEFAULT_WAYPOINT_DURATION_SEC`）。
 *
 * 字段的**角色**（循环 / 重复 / 静止）是命名上的判读，所以额外核一条：函数里读到的整数字段
 * 必须一个不多一个不少地落在这张角色表里——上游加了一个新字段，这里立刻报错。
 */
const TRAJECTORY_FIELD_ROLES = {
	active_waypoint_count: 'cycle',
	repeat_count: 'repeat',
	zero_hold_count: 'hold',
};

const readTrajectoryRules = () => {
	const source = read('src/embodied_common/embodied_common/trajectory_templates.py');
	const expansion = read('src/embodied_common/embodied_common/skill_templates.py');

	const dispatch = source.split('def expand_trajectory_template')[1];
	if (dispatch === undefined) throw new Error('trajectory_templates.py 里找不到 expand_trajectory_template');
	const routes = [...dispatch.matchAll(/if template_type == "([a-z0-9_]+)":\s*\n\s*return ([a-z_0-9]+)\(template\)/g)];
	if (routes.length === 0) throw new Error('expand_trajectory_template 的分派表一行都没解析出来');

	const durationField = expansion.match(/trajectory_template\.get\(\s*"([a-z_]+)",\s*step\.get\(/)?.[1];
	if (durationField === undefined) throw new Error('skill_templates.py 里找不到 waypoint_duration 的解析');
	const defaultDuration = Number(expansion.match(/DEFAULT_WAYPOINT_DURATION_SEC = ([\d.]+)/)?.[1]);
	if (!Number.isFinite(defaultDuration) || defaultDuration <= 0) {
		throw new Error('skill_templates.py 里找不到正的 DEFAULT_WAYPOINT_DURATION_SEC');
	}

	return routes.map((route) => {
		const [, templateType, generator] = route;
		const body = source.split(`def ${generator}(`)[1]?.split('\ndef ')[0];
		if (body === undefined) throw new Error(`trajectory_templates.py 里找不到生成器 ${generator}`);

		const read_fields = [...body.matchAll(/int\(template\.get\("([a-z_]+)", (\d+)\)\)/g)].map((item) => ({
			name: item[1],
			defaultValue: Number(item[2]),
		}));
		for (const field of read_fields) {
			if (TRAJECTORY_FIELD_ROLES[field.name] === undefined) {
				throw new Error(
					`生成器 ${generator} 读了一个没登记角色的字段 ${field.name}——轨迹展开规则表要跟着上游改`,
				);
			}
		}
		const byRole = new Map(read_fields.map((field) => [TRAJECTORY_FIELD_ROLES[field.name], field]));
		const cycle = byRole.get('cycle');
		const repeat = byRole.get('repeat');
		const hold = byRole.get('hold');
		if (cycle === undefined || repeat === undefined) {
			throw new Error(`生成器 ${generator} 里找不到循环拍数与重复次数这两个字段`);
		}
		if (repeat.defaultValue <= 0) throw new Error(`生成器 ${generator} 的重复次数缺省不是正数`);

		return {
			templateType,
			rule: hold === undefined ? 'cycle_repeat' : 'cycle_repeat_hold',
			cycleField: cycle.name,
			// 缺省 0 意味着「必须给」（生成器对非正数直接抛错），契约里不写这个假缺省。
			...(cycle.defaultValue > 0 ? { cycleDefault: cycle.defaultValue } : {}),
			repeatField: repeat.name,
			repeatDefault: repeat.defaultValue,
			...(hold === undefined ? {} : { holdField: hold.name, holdDefault: hold.defaultValue }),
			durationField,
			durationDefaultSec: defaultDuration,
		};
	});
};

/**
 * 原语参数的**单位与范围**：从模板的 `capability.parameters` 里读。
 *
 * 「哪些模板把这个字段交给了这条原语」正是 `PRIMITIVE_PARAMETERS` 那张表说的
 * （`<实参>` 或 `<实参>_from_request`）。同一个原语同一个字段被多个模板给出时，
 * 单位必须一致——不一致就是上游自己没说清，此时报错，不去挑一个。
 * **没有人给过单位就没有单位**：`duration_sec` 的「秒」写在字段名里，不是上游声明的 `unit`，
 * 所以它这里什么都不带（宁可不写，也不把名字当声明）。
 */
const readPrimitiveParameterHints = (skills) => {
	/** primitiveRef → 实参名 → {unit?, exclusiveMinimum?}。 */
	const hints = new Map();
	const remember = (primitiveRef, argument, property, where) => {
		const unit = typeof property?.unit === 'string' && property.unit !== '' ? property.unit : undefined;
		const exclusiveMinimum =
			typeof property?.exclusiveMinimum === 'number' ? property.exclusiveMinimum : undefined;
		if (unit === undefined && exclusiveMinimum === undefined) return;
		const seen = hints.get(primitiveRef)?.get(argument);
		if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify({ unit, exclusiveMinimum })) {
			throw new Error(
				`${where} 声明的单位/范围与别的模板对不上（${JSON.stringify(seen)} vs ${JSON.stringify({ unit, exclusiveMinimum })}）——上游自己没说清，不挑一个`,
			);
		}
		if (!hints.has(primitiveRef)) hints.set(primitiveRef, new Map());
		hints.get(primitiveRef).set(argument, { unit, exclusiveMinimum });
	};

	for (const [skillName, template] of Object.entries(skills)) {
		const properties = template?.capability?.parameters?.properties ?? {};
		for (const step of template?.primitive_sequence ?? []) {
			const primitiveRef = step?.primitive_name;
			for (const parameter of PRIMITIVE_PARAMETERS[primitiveRef] ?? []) {
				if (!(parameter.name in step) && step[`${parameter.name}_from_request`] !== true) continue;
				remember(
					primitiveRef,
					parameter.name,
					properties[parameter.name],
					`技能 ${skillName} 的 ${primitiveRef}.${parameter.name}`,
				);
			}
		}
	}
	return hints;
};

/**
 * 一条原语参数 + 上游声明的单位/范围 → 目录里的那个参数对象。
 *
 * `unit` / `exclusiveMinimum` **排在 `type` 前面**是有意的：重跑导入时，新增的键必须是一行
 * **纯插入**——排在末尾会让上一个键那一行多出一个逗号，那就成了「动了原有内容」
 * （判据：diff 里 `-` 行数必须是 0）。顺序对 zod 与键序规范化序列化都没有影响。
 */
const parameterOf = (parameter, hint) => ({
	name: parameter.name,
	label: parameter.label,
	...(hint?.unit === undefined ? {} : { unit: hint.unit }),
	...(hint?.exclusiveMinimum === undefined ? {} : { exclusiveMinimum: hint.exclusiveMinimum }),
	type: parameter.type,
});

// ---------------------------------------------------------------------------
// 上游事实：设备事实（命名位姿 / 执行量）
// ---------------------------------------------------------------------------

/** 三/四个分量都必须在：缺一个就报错，**不补 0**（补了就是编一个上游没写过的坐标）。 */
const componentsOf = (mapping, keys, where) => {
	const result = {};
	for (const key of keys) {
		const value = mapping?.[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new Error(`${where} 缺 ${key}（或不是有限数字）——不补默认值`);
		}
		result[key] = value;
	}
	return result;
};

/**
 * 命名位姿落在哪个坐标上（`robot.embodied.named_poses`）。
 *
 * 与 `catalog.namedPoses`（名字列表）**同一个键集、同一个顺序**：两边都从这一处产出，
 * 对不上就说明我们自己的代码分叉了，所以这里顺带核一次。
 * 位姿的参考系与单位上游没声明（YAML 里没有，`loader.py` 也不管），所以这里不写——
 * 「base 系」「米」都是对的，但「上游写着」这件事不成立。
 */
const namedPoseTargetsOf = (robotName, namedPoses) =>
	Object.entries(namedPoses ?? {}).map(([name, pose]) => {
		const where = `${robotName} 的 named_poses.${name}`;
		const position = pose?.position;
		const orientation = pose?.orientation;
		if (position === undefined && orientation === undefined) {
			throw new Error(`${where} 既没有 position 也没有 orientation——这条事实什么都没说`);
		}
		return {
			name,
			...(position === undefined
				? {}
				: { position: componentsOf(position, ['x', 'y', 'z'], `${where}.position`) }),
			...(orientation === undefined
				? {}
				: { orientation: componentsOf(orientation, ['x', 'y', 'z', 'w'], `${where}.orientation`) }),
		};
	});

/** 执行侧的量（`robot.embodied.execution`）。缺的字段不写——不替上游补默认值。 */
const executionFactsOf = (robotName, execution) => {
	if (execution === undefined) return undefined;
	const where = `${robotName} 的 embodied.execution`;
	const facts = {};
	if (execution.relative_motion_step_m !== undefined) {
		if (typeof execution.relative_motion_step_m !== 'number') throw new Error(`${where}.relative_motion_step_m 不是数字`);
		facts.relativeMotionStepM = execution.relative_motion_step_m;
	}
	if (execution.relative_motion_reference_frame !== undefined) {
		const frame = String(execution.relative_motion_reference_frame).trim();
		if (frame === '') throw new Error(`${where}.relative_motion_reference_frame 是空的`);
		facts.relativeMotionReferenceFrame = frame;
	}
	if (execution.relative_motion_direction_mapping !== undefined) {
		const mapping = {};
		for (const [direction, vector] of Object.entries(execution.relative_motion_direction_mapping)) {
			if (!Array.isArray(vector) || vector.length !== 3 || vector.some((item) => typeof item !== 'number')) {
				throw new Error(`${where}.relative_motion_direction_mapping.${direction} 不是三个数字`);
			}
			mapping[direction] = vector;
		}
		facts.relativeMotionDirectionMapping = mapping;
	}
	if (execution.gripper_open_position !== undefined) facts.gripperOpenPosition = execution.gripper_open_position;
	if (execution.gripper_closed_position !== undefined) facts.gripperClosedPosition = execution.gripper_closed_position;
	return Object.keys(facts).length === 0 ? undefined : facts;
};

/**
 * **执行侧的接口名表**：这台设备的技能/原语最后发到哪个 action、哪个 service、哪个 topic。
 *
 * 为什么现在要它：教学要能说到「这一步最后落到设备的哪个接口上」，而这件事目录里原本一个字
 * 都没有——原语那一层只说到 `move_to_named_pose(pose_name=…)` 为止。这些名字上游写着，
 * 导进来就是了。
 *
 * 三条纪律：
 *
 * 1. **这是配置级的**（一台设备一份），所以放在目录级（`catalog.interfaces`），
 *    不塞进单条原语里：原语与技能共用同一对 action，逐条原语各抄一遍必然分叉。
 * 2. **路径就是归属**：`embodied.*` 那五个在机器人 YAML 的 `embodied` 段下，
 *    `task_executor_action_name` / `move_configuration_service` 在 `embodied.execution` 下——
 *    上游的 launch builder 正是分两处读的（`embodied_config.get(...)` 与 `execution.get(...)`），
 *    下面 `assertInterfacesMatchLaunchBuilder` 拿它逐条核。
 * 3. **上游缺字段就不许造**：`move_configuration_service` 单臂那份没有，目录里就不写这一条
 *    ——`skill_executor_node.py` 里那个默认值不是这台设备声明过的事实。
 */
const INTERFACE_FIELDS = [
	{ key: 'task_command_topic', path: ['embodied', 'task_command_topic'], required: true },
	{ key: 'status_topic', path: ['embodied', 'status_topic'], required: true },
	{ key: 'skill_action_name', path: ['embodied', 'skill_action_name'], required: true },
	{ key: 'primitive_action_name', path: ['embodied', 'primitive_action_name'], required: true },
	{ key: 'validate_skill_service', path: ['embodied', 'validate_skill_service'], required: true },
	{
		key: 'task_executor_action_name',
		path: ['embodied', 'execution', 'task_executor_action_name'],
		required: false,
	},
	{
		key: 'move_configuration_service',
		path: ['embodied', 'execution', 'move_configuration_service'],
		required: false,
	},
];

/** 接口名表 vs 上游 launch builder：每个键都要在那个文件里被读过，且读它的是**同一段**配置。 */
const assertInterfacesMatchLaunchBuilder = () => {
	const builder = read('src/embodied_bringup/embodied_bringup/launch_builders/embodied.py');
	for (const field of INTERFACE_FIELDS) {
		// 路径长度 2 = `embodied.<key>`（builder 读 `embodied_config`）；3 = `embodied.execution.<key>`
		// （builder 读 `execution`）。归属不是我们分的，是上游读法分好的。
		// 正则里的 `\s*` 是必须的：上游有个 `.get(` 换行写（`move_configuration_service`），
		// 按字面串匹配会把它判成「不是从这儿读的」——那是我们看错了，不是上游的问题。
		const section = field.path.length === 2 ? 'embodied_config' : 'execution';
		const reading = new RegExp(`${section}\\.get\\(\\s*"${field.key}"`);
		if (!reading.test(builder)) {
			throw new Error(
				`接口 ${field.key} 在 launch builder 里不是从 ${section} 读的——路径表里的归属要对上上游的读法`,
			);
		}
	}
};

/** 这台设备的接口名表：按 `INTERFACE_FIELDS` 的顺序取，缺一个必填的就报错。 */
const interfacesOf = (robotName, robot) => {
	const interfaces = {};
	for (const field of INTERFACE_FIELDS) {
		const value = readPath(robot, field.path);
		if (value === undefined) {
			if (field.required) throw new Error(`${robotName}：取不到接口名 ${field.path.join('.')}`);
			continue;
		}
		if (typeof value !== 'string' || value.trim() === '') {
			throw new Error(`${robotName}：接口名 ${field.path.join('.')} 不是非空字符串`);
		}
		interfaces[field.key] = value.trim();
	}
	return interfaces;
};

/**
 * 运行时能力：`gateway_policy.py` 里那三样一起读，因为它们是同一个键集的三面——
 * 字段名（`SkillRequirements` 的 dataclass）、顺序（`_CAPABILITY_ORDER`）、
 * 缺了怎么说（`_CAPABILITY_UNAVAILABLE_MESSAGES`）。三面对不上就报错，不挑一个。
 *
 * 为什么要有这一层：一条原语**不是想跑就能跑**——`move_relative_ee` 得先有新的末端位姿
 * （`fresh_ee_pose`），`move_to_joint_positions` 得先有轨迹通道（`arm_trajectory`）。
 * 这是「这台设备得先具备什么」的事实，教学讲「这一步为什么可能做不了」时只有它能依据。
 *
 * 返回 `{ map, fields }`：`map` 是 primitiveRef → 能力名数组（按 `_CAPABILITY_ORDER` 排），
 * `fields` 是 dataclass 的字段顺序（对账用）。
 */
const readRuntimeCapabilities = () => {
	const source = read('src/skill_library/skill_library/gateway_policy.py');

	const dataclass = source.split('class SkillRequirements:')[1]?.split(/\n@|^class /m)[0] ?? '';
	const fields = [...dataclass.matchAll(/^ {4}([a-z_][a-z0-9_]*): bool = False$/gm)].map((match) => match[1]);
	if (fields.length === 0) throw new Error('gateway_policy.py 里解析不出 SkillRequirements 的字段');

	const orderBody = source.split('_CAPABILITY_ORDER = (')[1]?.split(')')[0] ?? '';
	const order = [...orderBody.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
	const messagesBody = source.split('_CAPABILITY_UNAVAILABLE_MESSAGES = {')[1]?.split(/\n\}/)[0] ?? '';
	const messages = new Map(
		[...messagesBody.matchAll(/"([a-z_]+)": "([^"]+)"/g)].map((match) => [match[1], match[2]]),
	);
	if (order.length === 0 || messages.size === 0) {
		throw new Error('gateway_policy.py 里解析不出 _CAPABILITY_ORDER / _CAPABILITY_UNAVAILABLE_MESSAGES');
	}
	// 三面必须同一个键集、同一个顺序：少一个就说明上游改了其中一处而我们只读到了另一处。
	for (const [index, name] of order.entries()) {
		if (fields[index] !== name) {
			throw new Error(`能力顺序对不上：_CAPABILITY_ORDER[${index}]=${name}，dataclass 那个位置是 ${fields[index]}`);
		}
		if (!messages.has(name)) throw new Error(`能力 ${name} 在 _CAPABILITY_UNAVAILABLE_MESSAGES 里没有那句话`);
	}
	for (const name of messages.keys()) {
		if (!order.includes(name)) throw new Error(`_CAPABILITY_UNAVAILABLE_MESSAGES 里的 ${name} 不在 _CAPABILITY_ORDER 里`);
	}

	const mapBody = source.split('_PRIMITIVE_CAPABILITY_MAP')[1]?.split(/\n\}/)[0] ?? '';
	const entries = [...mapBody.matchAll(/^ {4}"([a-z_]+)": SkillRequirements\(([^)]*)\),?$/gm)];
	if (entries.length === 0) throw new Error('gateway_policy.py 里解析不出 _PRIMITIVE_CAPABILITY_MAP');

	const map = new Map();
	for (const [, primitiveRef, kwargs] of entries) {
		const enabled = new Set(
			[...kwargs.matchAll(/([a-z_][a-z0-9_]*)=True/g)].map((match) => match[1]),
		);
		for (const name of enabled) {
			if (!fields.includes(name)) {
				throw new Error(`${primitiveRef} 登记了能力 ${name}，但它不是 SkillRequirements 的字段`);
			}
		}
		// `=False` 是 dataclass 的缺省，不写进目录——目录里只留「这条原语确实要的那几条」。
		map.set(
			primitiveRef,
			order.filter((name) => enabled.has(name)).map((name) => ({ name, unavailableMessage: messages.get(name) })),
		);
	}
	return { map, fields };
};

/**
 * 一条原语 → 它在**这台设备上**要哪些运行时能力。
 *
 * 上游没登记的（`move_to_pose` / `move_to_configuration` 那两条）**不写这个字段**：
 * 空数组与「上游没登记」是两件事。返回 `undefined` 时调用方把键整条省掉。
 */
const runtimeCapabilitiesOf = (primitiveRef, capabilityMap) => {
	const capabilities = capabilityMap.get(primitiveRef);
	return capabilities === undefined || capabilities.length === 0 ? undefined : capabilities;
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
 * 除了类型，还要把上游**写着的东西**带过来——`unit`、`exclusiveMinimum`、`required`。
 * 早先这里只取了类型，于是「米 / 度」这种单位在界面上丢了，
 * 而「这个参数必填」这条约束也没了，缺参数只能含糊地报一句提醒。
 * 判据在上游，核心不自己发明。
 *
 * `exclusiveMinimum` 同样排在 `type` 前面，理由见 `parameterOf`：新增的键要是一行纯插入。
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
			...(typeof spec?.exclusiveMinimum === 'number' ? { exclusiveMinimum: spec.exclusiveMinimum } : {}),
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
const capabilityMap = readRuntimeCapabilities();
const resolverBranches = readResolverBranches();
assertDeviceFactsMatchResolver(resolverBranches);
const trajectoryTemplates = readTrajectoryRules();

/**
 * 原语表 + 上游声明的单位/范围 + 「落到哪条事实上」+ 「要设备先具备哪些运行时能力」。
 *
 * 四样都是**上游事实**：参数表是人对 `resolver.py` 的判读（下游有对账），
 * 单位/范围从模板的 `capability.parameters` 里读，设备事实那张表的每一条都对着
 * `resolver.py` 的分支核过（`assertDeviceFactsMatchResolver`），
 * 运行时能力从 `gateway_policy.py` 的三张表里读（三面互相对账，见 `readRuntimeCapabilities`）。
 */
const primitivesOf = (skills) => {
	const hints = readPrimitiveParameterHints(skills);
	return primitiveTable.map(({ primitiveRef, summary }) => {
		const parameters = PRIMITIVE_PARAMETERS[primitiveRef];
		if (parameters === undefined) {
			throw new Error(`README 列出的原语 ${primitiveRef} 没有参数表——上游加了新原语，参数表要跟着改`);
		}
		const deviceFacts = PRIMITIVE_DEVICE_FACTS[primitiveRef];
		const runtimeCapabilities = runtimeCapabilitiesOf(primitiveRef, capabilityMap.map);
		return {
			primitiveRef,
			label: summary.split('，')[0] ?? summary,
			summary,
			// 插在 `parameters` **前面**同样是纯插入（`summary` 那一行本来就带逗号）。
			...(deviceFacts === undefined ? {} : { deviceFacts }),
			...(runtimeCapabilities === undefined ? {} : { runtimeCapabilities }),
			parameters: parameters.map((parameter) =>
				parameterOf(parameter, hints.get(primitiveRef)?.get(parameter.name)),
			),
		};
	});
};

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

	const primitives = primitivesOf(skills);
	const namedPoses = Object.keys(robot.embodied.named_poses ?? {});
	const namedPoseTargets = namedPoseTargetsOf(robotName, robot.embodied.named_poses);
	const execution = executionFactsOf(robotName, robot.embodied.execution);
	// 接口名表：必填的那几个取不到就在里面报错，不在这里兜。
	assertInterfacesMatchLaunchBuilder();
	const interfaces = interfacesOf(robotName, robot);

	// 对账 0：名字列表与坐标表必须同一个键集。两边都是从这一处 YAML 产出的，
	// 对不上就说明我们自己的代码分叉了——那正是「屏幕上每个字都对得上事实」最怕的事。
	const targetNames = namedPoseTargets.map((target) => target.name);
	if (JSON.stringify(targetNames) !== JSON.stringify(namedPoses)) {
		throw new Error(`${robotName}：namedPoseTargets 与 namedPoses 的键集/顺序对不上（${targetNames} vs ${namedPoses}）`);
	}

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
			namedPoses,
			namedPoseTargets,
			...(execution === undefined ? {} : { execution }),
			trajectoryTemplates,
			// 插在 `primitives` **前面**：与 `runtimeCapabilities` 同一个理由（纯插入）。
			interfaces,
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
			[...used].every((name) => capabilityMap.map.has(name)) ? '' : '（有原语不在 gateway_policy 表里，查一下）'
		}`,
	);
	const withFacts = primitives.filter((primitive) => primitive.deviceFacts !== undefined);
	const withHints = primitives.flatMap((primitive) =>
		primitive.parameters.filter((parameter) => parameter.unit !== undefined || parameter.exclusiveMinimum !== undefined),
	);
	const withCapabilities = primitives.filter((primitive) => primitive.runtimeCapabilities !== undefined);
	console.log(
		`  设备事实：${namedPoseTargets.length} 个命名位姿的坐标、${
			execution === undefined ? '没有 execution 段' : Object.keys(execution).length + ' 项执行量'
		}、${trajectoryTemplates.length} 条轨迹展开规则（${trajectoryTemplates
			.map((rule) => `${rule.templateType}/${rule.rule}`)
			.join('、')}）、${withFacts.length} 条原语登记了落点、${withHints.length} 个原语参数带单位或范围`,
	);
	// 新增的两层（喂提示词用）：接口名表与「原语要设备先具备什么」。
	console.log(
		`  执行侧接口名：${Object.keys(interfaces).length} 条（${Object.keys(interfaces).join('、')}）；` +
			`运行时能力：${withCapabilities.length}/${primitives.length} 条原语登记了（${[
				...new Set(withCapabilities.flatMap((primitive) => primitive.runtimeCapabilities.map((item) => item.name))),
			]
				.sort()
				.join('、')}），其余上游没登记`,
	);
	console.log(`  → ${outFile}`);
};

// commit 是**仓库级**的：多份目录同源同版本，出处必须一致，所以在这里取一次。
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcRoot }).toString().trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: srcRoot }).toString().trim();

for (const robotName of robotNames) buildCatalog(robotName);

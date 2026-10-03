/**
 * 「任务 JSON + 目录 → 教学规格」这一步的提示词：**材料全部由目录现生成**。
 *
 * 这一层与 `task-generation.ts` 的 `skillPlanSystemPrompt` 是同一条纪律的两处落点：
 * 不许在这里手写技能清单、参数、坐标。目录长什么样，材料就是什么样——目录一更新，
 * 材料跟着更新。手写一份的下场是模型照着手写的那份说，而校验器拿的是真目录，
 * 于是每一句都成了错话（`task-generation.ts` 顶上那段写的就是这件事）。
 *
 * 材料分六块，每一块都是**上游说过的字**（没有一句是我们的转述）：
 *
 * 1. 这次的任务 JSON（机器要吃的那份，原样）；
 * 2. 技能清单：目录里的 `capabilities`（名字、中文 label、一句话、参数、实现语句树）；
 * 3. 原语清单：目录里的 `primitives`（含 `runtimeCapabilities`——这条原语要设备先具备什么）；
 * 4. 这台设备的**执行侧接口名**（`catalog.interfaces`，上游 YAML 里那些 action / topic / service）；
 * 5. 这台设备的**设备事实**（命名位姿落在哪个坐标、一步多远、夹爪开合位、轨迹模板怎么展开）；
 * 6. 本次任务**真正用到的那几步**按任务参数解析后的实参 → 事实（`describeDeviceFacts` 的原文）。
 *
 * 第 6 块是这一层最要紧的一块：目录里那些事实要落到**这一次的取值**上才有用——
 * 「`pose_name="observe_table"` → 位置 x=… y=… z=…」比「有一个位姿表」强得多。
 * 取不到的实参（任务没给、或引用了解不出的名字）就不产出那一行：说不出来就什么都不说。
 */
import {
	describeDeviceFacts,
	describeInterfaces,
	describeRuntimeCapabilities,
	findCapability,
	PLAN_PATH_PATTERN,
	type CapabilityCatalog,
	type CapabilitySpec,
	type ImplArgument,
	type ImplStatement,
	type JsonValue,
	type PrimitiveSpec,
	type WorkflowDeclaration,
	type WorkflowNode,
} from '@codecanvas/contracts';

/**
 * 规矩（system）。形状说死、纪律说死，材料在 user 那条里。
 *
 * 三条纪律里有两条是导演定的硬要求，写在这里也写在 `contracts/teaching-spec.ts` 的文件头：
 * 「目录里有的必须照目录说」与「不许一块包全部」。第三条「模型赢」落到提示词上只有一句话：
 * 与任务 JSON 对不上不用改、也不用解释，照你理解的讲（拦与不拦都在我们这一侧）。
 *
 * 这一版多了一整块「对应关系」：屏幕上那三样要跟着设备**执行到第几步**一起走
 * （流程图那个框亮、积木切过去、代码切到那几行）。这件事我们做不了主——它靠的是
 * 你写出来的三栏（节点的 `planPath`、块的 `planPath`、代码分段的 `planPath`）。
 * 所以下面不但要求写，还逐条说清**写错/不写会怎样**：那些后果就是校验器真的会做的事。
 */
export const TEACHING_SYSTEM_PROMPT = `你是机器人技能的**教学作者**。用户给你一份已经定稿的任务 JSON，以及这台设备的能力目录。你把这件事讲成一个新手看得懂的教学规格。只输出合法 JSON，不要输出 Markdown、不要解释。

JSON 的形状（字段名一个字都不许改）：
{
  "version": 2,
  "title": "这次教学的名字（一行）",
  "flow": {
    "nodes": [
      {"id":"start","kind":"start","title":"开始"},
      {"id":"n1","kind":"action","title":"移动到观察位","detail":"pose_name=observe_table","planPath":"0"},
      {"id":"n2","kind":"decision","title":"看到桌面了吗","planPath":"1"},
      {"id":"n3","kind":"wait","title":"等 1 秒","planPath":"2"}
    ],
    "edges": [{"from":"start","to":"n1"}, {"from":"n2","to":"n3","arm":"then","label":"是"}, ...]
  },
  "blocks": [ 语句块… ],
  "codeSegments": [{"planPath":"n1","lines":["一行代码","又一行"]}, ...]
}

【流程图 flow】
- 节点种类只有五种：start（开始）、end（结束）、action（一个动作/技能/一步）、decision（条件分支）、wait（等待）。
- 必须**正好一个** start，**至少一个** end；除 start 外每个节点都要能从 start 走到（有向边连得到）。
- id 用字母开头、只含字母数字下划线；title 一行、不超过 64 字；detail 可选（参数摘要 / 判据 / 说明），不超过 120 字。
- **只有 decision 节点的出边**可以、并且必须带 "arm"（"then" / "else"），同一个 decision 的两条出边不能同臂；
  别的节点的出边不许带 arm。
- 边上的 label 可选（不写时我们画「是 / 否」）。
- 节点数控制在 4～12 个：图是**讲解的主线**，不是把每一步都摊开。

【积木 blocks】一棵**可嵌套**的块树（顶层就是一串语句）。语句块五种：
- {"kind":"call","label":"块上一个动作的名字","args":[{"name":"实参名","value":值块}],"planPath":"n1"}
- {"kind":"if","condition":值块,"body":[语句块…],"otherwise":[语句块…],"planPath":"n2"}   ← C 形块
- {"kind":"repeat","times":值块,"body":[语句块…],"planPath":"n1"}                        ← C 形块
- {"kind":"wait","seconds":值块,"planPath":"n3"}
- {"kind":"note","text":"一句讲解（不做动作）","planPath":"n1"}
值块四种：{"kind":"number","value":0.03}、{"kind":"text","value":"observe_table"}、
{"kind":"bool","value":true}、{"kind":"call","label":"…","args":[…]}
（值块是**插进调用块槽位里的另一块积木**，不是写在块上的一行字；值块不写 planPath——它跟着自己那个调用块。）
**每种块只许带它自己那几个键，多一个键整份规格会被拒**（实测踩过：给 call 加 "body" 就被拒了）。
具体地说：call 只有 label / args / planPath，wait 只有 seconds / planPath，note 只有 text / planPath
——这三种**不许**出现 "body" / "otherwise" / "condition" / "times"（那是 C 形块的键）；
只有 if 有 condition / body / otherwise，只有 repeat 有 times / body。
想讲「合上夹爪，然后往前走一点」，写成**平着排的两块**，不要写成一块带 body 的 call。
**硬要求：不许一块包全部。** 一个动作至少要拆成「调用块 + 实参值块」；
有判断就是 C 形块 + 里面嵌语句链。整棵树只有一块，这份规格就不合格。

【教学代码 codeSegments】
把整段教学代码**按步切开**，一段一个对象：\`planPath\` 是这一段讲哪个流程节点（写流程节点的 id），
\`lines\` 是这一段的那几行（一个字符串数组，一行一个元素；空行写成 ""）。我们按顺序拼起来，就是你写的那段代码。
- 带注释的代码文本：这件事从头到尾怎么做、为什么这么做、失败怎么办。它是**给人读的**，不是从积木翻译的。
- 同一步的文字要**连着写完**再写下一步：中间插了别的步，「切到那几行」就切不出一段连续的行。
- 不要为了分段在段之间留空行：空行属于某一行的末尾，不单独成段。

【最重要的一件事：三处都要写出「这是任务 JSON 里的哪一步」（planPath）】
跑起来之后，设备执行到第几步，屏幕上就要跟着动：流程图上那个框亮起来、积木切到那一步的块、
代码切到那一步那几行。**这件事完全靠你写出来的对应关系**，我们不会替你猜一个。
所以三处都要写，而且指的地方必须真的存在：

1. **每个流程节点**（action / decision / wait）写 "planPath"：它讲的是任务 JSON 里的哪一步。
   取值是**执行路径**，样子就是 ${String(PLAN_PATH_PATTERN)}：顶层第几步就写那个下标（第 1 步写 "0"，第 3 步写 "2"）；
   走到某条臂里的一步，就接着写臂再写臂内的下标（第 2 步那个分支的「那么」臂里的第 1 步写 "1.then.0"）。
   **能写哪些路径，看材料最后那块「每一步的执行路径」——那张表是设备实际会走到的位置，照抄。**
   start 与 end 两个框**不许**写 planPath：它们不是任务 JSON 里的步骤。
   写错会怎样：指着一个不存在的步（写了个没在那张表里的路径、或者下标越界），**整份规格会被拒**，
   界面上就是「模型没画出来」，一句图都没有。
2. **每棵顶层积木**写 "planPath"：它属于**哪个流程节点**——注意这里写的是**流程节点的 id**（n1 那种），
   不是执行路径；嵌套在肚子里的块不写就跟父块走（也可以自己写一个不同的）。
   写错会怎样：写了个不在图上的 id，**整份规格会被拒**；顶层一块都不写，规格仍然能用、图照画，
   但积木那一栏跟不了当前步（界面上会照实说「没接上联动」）。
3. **每一段代码**写 "planPath"：也是**流程节点的 id**，说的是「这一段讲的是哪一步」。
   写错会怎样：写了个不在图上的 id，**整份规格会被拒**；同一步的文字被别的步隔开也会被拒。

【怎么把一步拆开（这是这一版最容易被做错的地方）】
- 目录里**写着实现**的技能（技能清单里那行「实现：…」），要把它**展开成多块**：
  这个技能一块（父块），它内部那几条原语调用各自一块，实参各插一个值块。
  例：inspect_scene 的实现是 move_to_named_pose(pose_name="observe_table")，
  那就画成 inspect_scene 一块 + 它下面 move_to_named_pose 一块 + pose_name 插一个
  "observe_table" 值块（不要只画一块 inspect_scene 就完事）。
- 目录里**没写实现**的技能（技能清单里那行是「委托给执行侧接口 …」），
  只画一块 + 用说明块把它的管线讲清楚（这是讲解，不要编数值）。
- 需要判断的地方就画 C 形条件块（if），肚子里嵌那条链；重复就画 repeat；
  要停一下就画 wait。**别把好几件事塞进一个块的文字里**。

【三条纪律，必须遵守】
1. **目录里有的，必须照目录说，一个字都不许改**：技能名、原语名、参数名、命名位姿名、
   坐标、到位值、时长、模板名与拍数——凡是目录里写着的，就照它写。
2. **目录里没有的（执行侧内部怎么做的）可以讲**，比如抓取时的「视觉定位 → 规划 → 靠近 →
   合爪 → 抬起 → 验证」这种管线：这是讲解，应该讲清楚。但**不许编具体数值**——
   不要给目录里没有的坐标、距离、时长、到位值、阈值。说不出来就只说在做什么。
3. 任务 JSON 与目录对不上、或你觉得任务 JSON 有毛病，**不用改它、也不用解释**，
   照你能讲的部分讲完整就行。`;

/** 写死的实参取值；不是字面量（参数引用、嵌套调用、算术）时 undefined。 */
const literalValueOf = (argument: ImplArgument): JsonValue | undefined => {
	if (typeof argument === 'number' || typeof argument === 'string' || typeof argument === 'boolean') {
		return argument;
	}
	if (Array.isArray(argument)) return argument;
	return argument.kind === 'literal' ? argument.value : undefined;
};

/** 实参取值 → 一行可读文本。`literal` 直接给值，`param` 说它来自哪个任务参数。 */
const argumentText = (argument: ImplArgument): string => {
	if (typeof argument === 'number' || typeof argument === 'string' || typeof argument === 'boolean') {
		return JSON.stringify(argument);
	}
	if (Array.isArray(argument)) return JSON.stringify(argument);
	if (argument.kind === 'literal') return JSON.stringify(argument.value);
	if (argument.kind === 'param') return `任务参数 ${argument.name}`;
	if (argument.kind === 'call') return `${argument.primitiveRef}(…)`;
	if (argument.kind === 'binary') return `(${argument.operator} …)`;
	return `(not …)`;
};

/** 实参那一串：`pose_name="observe_table", duration_sec=1.5`。 */
const argumentsText = (arguments_: Record<string, ImplArgument>): string =>
	Object.entries(arguments_).map(([name, value]) => `${name}=${argumentText(value)}`).join(', ');

/** 一次调用的写法：`move_to_named_pose(pose_name="observe_table")`。 */
const callText = (ref: string, arguments_: Record<string, ImplArgument>): string =>
	`${ref}(${argumentsText(arguments_)})`;

/** 一棵实现语句树 → 几行缩进文本（`if` 的两条臂缩进一级）。 */
const statementLines = (statements: readonly ImplStatement[], indent = ''): string[] =>
	statements.flatMap((statement) => {
		if (statement.kind === 'call') return [`${indent}${callText(statement.primitiveRef, statement.arguments)}`];
		if (statement.kind === 'delegate') {
			return [`${indent}委托给执行侧接口 ${statement.interfaceRef}（${argumentsText(statement.arguments)}）`];
		}
		if (statement.kind === 'set') return [`${indent}${statement.target} = ${argumentText(statement.value)}`];
		const condition = statement.condition.kind === 'param' ? statement.condition.name : '（条件）';
		return [
			`${indent}如果 ${condition}：`,
			...statementLines(statement.then, `${indent}    `),
			...(statement.else === undefined
				? []
				: [`${indent}否则：`, ...statementLines(statement.else, `${indent}    `)]),
		];
	});

/** 一个技能：名字、中文、一句话、参数、实现（人话）、落到哪儿。 */
const capabilityLines = (capability: CapabilitySpec, catalog: CapabilityCatalog): string[] => {
	const parameters =
		capability.parameters.length === 0
			? '无参数'
			: capability.parameters
					.map(
						(parameter) =>
							`${parameter.name}(${parameter.type}${parameter.unit === undefined ? '' : `/${parameter.unit}`}${
								parameter.required === true ? '，必填' : ''
							})`,
					)
					.join('、');
	const lines = [`- ${capability.capabilityRef}（${capability.label}）：${parameters}`];
	if (capability.summary !== undefined) lines.push(`    目录里的说法：${capability.summary}`);
	lines.push(`    实现：${statementLines(capability.implementation).join(' / ')}`);
	// 只有写死的实参才在这里落到事实上（参数引用要等任务给值，那是第 6 块的事）。
	for (const statement of capability.implementation) {
		if (statement.kind !== 'call') continue;
		const primitive = catalog.primitives.find((item) => item.primitiveRef === statement.primitiveRef);
		if (primitive === undefined) continue;
		const values: Record<string, JsonValue | undefined> = {};
		for (const [name, argument] of Object.entries(statement.arguments)) {
			values[name] = literalValueOf(argument);
		}
		for (const line of describeDeviceFacts(catalog, primitive, values)) {
			lines.push(`    落到：${line.trim()}`);
		}
	}
	return lines;
};

/** 一条原语：名字、中文、一句话、参数、**要设备先具备什么**。 */
const primitiveLines = (primitive: PrimitiveSpec): string[] => {
	const parameters =
		primitive.parameters.length === 0
			? '无参数'
			: primitive.parameters
					.map((parameter) => {
						const unit = parameter.unit === undefined ? '' : `/${parameter.unit}`;
						const range =
							parameter.exclusiveMinimum === undefined ? '' : `，必须大于 ${String(parameter.exclusiveMinimum)}`;
						return `${parameter.name}(${parameter.type}${unit}${range})`;
					})
					.join('、');
	const lines = [`- ${primitive.primitiveRef}（${primitive.label}）：${parameters}`];
	if (primitive.summary !== undefined) lines.push(`    目录里的说法：${primitive.summary}`);
	const capabilities = describeRuntimeCapabilities(primitive);
	if (capabilities.length > 0) lines.push(`    要设备先具备：${capabilities.join('、')}`);
	return lines;
};

/** 设备事实里那几张表：命名位姿的坐标、执行量、轨迹模板怎么展开。 */
const deviceFactLines = (catalog: CapabilityCatalog): string[] => {
	const lines: string[] = [];
	const poses = catalog.namedPoseTargets ?? [];
	if (poses.length > 0) {
		lines.push(`命名位姿（${poses.length} 个，名字必须照这里写）：`);
		for (const pose of poses) {
			const position =
				pose.position === undefined
					? '没有位置'
					: `x=${String(pose.position.x)} y=${String(pose.position.y)} z=${String(pose.position.z)}`;
			const orientation =
				pose.orientation === undefined
					? '没有姿态'
					: `四元数 (${String(pose.orientation.x)}, ${String(pose.orientation.y)}, ${String(pose.orientation.z)}, ${String(pose.orientation.w)})`;
			lines.push(`  ${pose.name}：${position}；${orientation}`);
		}
	}

	const execution = catalog.execution;
	if (execution !== undefined) {
		lines.push('执行量（上游 embodied.execution）：');
		if (execution.relativeMotionStepM !== undefined) {
			lines.push(
				`  相对运动一步 ${String(execution.relativeMotionStepM)} m${
					execution.relativeMotionReferenceFrame === undefined
						? ''
						: `（${execution.relativeMotionReferenceFrame} 系）`
				}`,
			);
		}
		for (const [direction, vector] of Object.entries(execution.relativeMotionDirectionMapping ?? {})) {
			lines.push(`  方向 ${direction} → (${vector.map((item) => String(item)).join(', ')})`);
		}
		if (execution.gripperOpenPosition !== undefined) {
			lines.push(`  夹爪张开位 ${String(execution.gripperOpenPosition)}`);
		}
		if (execution.gripperClosedPosition !== undefined) {
			lines.push(`  夹爪闭合位 ${String(execution.gripperClosedPosition)}`);
		}
	}

	const templates = catalog.trajectoryTemplates ?? [];
	if (templates.length > 0) {
		lines.push('轨迹模板怎么展开（照目录里的规则算，不要自己编拍数）：');
		for (const rule of templates) {
			lines.push(
				`  ${rule.templateType}：${rule.cycleField} × ${rule.repeatField}${
					rule.holdField === undefined ? '' : ` + ${rule.holdField}`
				}，每拍 ${String(rule.durationDefaultSec)} 秒`,
			);
		}
	}
	return lines;
};

/** 任务里那一步的实参取值：写死的给写死的，引用任务参数的**去任务 JSON 里取真值**。 */
const resolvedArguments = (
	statement: ImplStatement,
	parameters: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue | undefined> => {
	if (statement.kind !== 'call' && statement.kind !== 'delegate') return {};
	const values: Record<string, JsonValue | undefined> = {};
	for (const [name, argument] of Object.entries(statement.arguments)) {
		// 写死的给写死的；引用任务参数的**去任务 JSON 里取真值**；别的（嵌套调用、算术）解不出来就不写。
		values[name] =
			typeof argument === 'object' && !Array.isArray(argument) && argument.kind === 'param'
				? parameters[argument.name]
				: literalValueOf(argument);
	}
	return values;
};

/**
 * 这份任务的**实际取值落到哪些事实上**：一步一行，取不到就什么都不写。
 *
 * 为什么单独列一块：上面第 5 块说的是「这台设备有什么」，这一块说的是「**这一次**用了哪个值、
 * 它落在哪」。模型要照着讲「移动到 observe_table，也就是 x=… y=… z=…」，
 * 依据只能是这一块——让它自己去位姿表里找，找到的是它自己的选择，不是这一次调用的事实。
 */
const taskFactLines = (declaration: WorkflowDeclaration, catalog: CapabilityCatalog): string[] => {
	const lines: string[] = [];
	for (const node of declaration.nodes) {
		const raw = node.parameters['action'];
		if (typeof raw !== 'string') continue;
		const capability = findCapability(catalog, raw);
		for (const statement of capability?.implementation ?? []) {
			if (statement.kind === 'delegate') {
				lines.push(
					`- ${node.name}：委托给 ${statement.interfaceRef}（${
						Object.keys(statement.arguments).join('、') || '没有实参'
					}）——实现在执行侧，目录里没有它的步骤`,
				);
				continue;
			}
			if (statement.kind !== 'call') continue;
			const primitive = catalog.primitives.find((item) => item.primitiveRef === statement.primitiveRef);
			if (primitive === undefined) continue;
			const values = resolvedArguments(statement, node.parameters);
			lines.push(`- ${node.name}：${callText(statement.primitiveRef, statement.arguments)}`);
			for (const fact of describeDeviceFacts(catalog, primitive, values)) lines.push(`    ${fact}`);
		}
	}
	return lines;
};

/**
 * user 那条消息：任务 JSON + 目录的直接序列化。**顺序就是上面那七块**。
 *
 * `declarationText` 由调用方给（生成那条路留着模型吐出来的原文；导入那条路给规范化 JSON）。
 * 这里不自己序列化声明——两种来源都叫「这次的任务 JSON」，谁拿到就交谁，别在这里再造一份。
 *
 * 第 7 块（每一步的执行路径）是这一版加的：规格里那三栏 `planPath` 要照着它写。
 * 这张表**由计划结构列出来**（`planPathsOf`，与设备报的 `runningPlanPath` 同一份口径），
 * 不是这里手写的一张清单——手写一张的下场是模型照着手写的那份写，而校验器拿的是真结构。
 */
export const teachingMaterialOf = (
	declaration: WorkflowDeclaration,
	catalog: CapabilityCatalog,
	declarationText: string,
	/** 每一步的执行路径 → 那一步。缺省就从没人给——那一块说「列不出来」，不编一张。 */
	planPaths?: ReadonlyMap<string, WorkflowNode>,
): string => {
	const sections: string[] = [
		`【这台设备】${catalog.displayName}（robotName=${catalog.robotName ?? '未知'}，目录 ${catalog.catalogRef}）`,
		`【这次的任务 JSON】\n${declarationText}`,
		`【技能清单（目录原文，技能名只能从这里来）】\n${catalog.capabilities
			.map((capability) => capabilityLines(capability, catalog).join('\n'))
			.join('\n')}`,
		`【原语清单（目录原文）】\n${catalog.primitives.map((primitive) => primitiveLines(primitive).join('\n')).join('\n')}`,
		`【这台设备的执行侧接口名（上游配置里写着的）】\n${
			describeInterfaces(catalog).join('\n') || '（这台设备的配置里没有导到接口名）'
		}`,
		`【这台设备的设备事实】\n${deviceFactLines(catalog).join('\n') || '（这台设备没有导到设备事实）'}`,
		`【这次任务用到的那几步，落到哪儿】\n${taskFactLines(declaration, catalog).join('\n') || '（没有可解析的步骤）'}`,
	];
	if (planPaths !== undefined) {
		sections.push(
			`【每一步的执行路径（写 planPath 时照这张表抄，一个字都别改）】\n${
				stepPathLines(planPaths).join('\n') || '（这份声明里没有走得通的步骤）'
			}`,
		);
	}
	return sections.join('\n\n');
};

/**
 * 每一步一行：`路径 ← 第几步 · 显示名`。
 *
 * 为什么要连显示名一起给：模型要认出「这一步」是哪一步，靠的只能是任务 JSON 里那个名字
 * （技能名、`wait 2s`、分支的条件），而路径本身是一串下标，认不出任何东西。
 * 两样并排摆着，它才能把「讲这一步的那个框」对到一条具体的路径上。
 */
const stepPathLines = (planPaths: ReadonlyMap<string, WorkflowNode>): readonly string[] =>
	[...planPaths].map(([path, node]) => `- ${path} ← ${node.name}`);

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { generateCompetitionDesign } = require('../../packages/@n8n/competition-designer/dist');
const { SO101_CATALOG_SNAPSHOT } = require('../../packages/@n8n/blockly-robot-skills/dist');

const outputDirectory = fileURLToPath(new URL('../../docs/competition/demo/', import.meta.url));
const catalog = {
	...SO101_CATALOG_SNAPSHOT,
	robotName: 'rk3588_training_arm',
	configDigest: 'rk3588-classroom-demo-v2',
};

const initialInput = {
	lesson: {
		title: 'AI 可解释机器人课堂：观察、解释与确认',
		objective: '让学员把一段 AI 开发逻辑对应到数据、积木、计划和执行记录。',
	},
	engagementScore: '78',
	students: [
		{ profile: { name: '小林' }, active: true },
		{ profile: { name: '小陈' }, active: true },
		{ profile: { name: '小周' }, active: false },
	],
	teacher: { name: '张老师', approvalRequired: true },
	robotTask: {
		goal: '观察讲台区域、向课堂问候并回到安全位。',
		boundary: '仅在校验通过、教师确认和设备侧运动授权齐备后进入 RoboFrame 执行。',
	},
};

const draft = {
	schemaVersion: '2.0',
	designId: 'demo.ai-explainable-robot-classroom',
	revisionId: 'revision-1',
	name: 'AI 可解释机器人课堂 · 中文完整演示',
	logicNodes: [
		{
			nodeRef: 'logic.normalize-classroom-input',
			label: '规范化课堂输入',
			outputMode: 'copyInput',
			statements: [
				{
					kind: 'set',
					intentStepId: 'logic.normalize-engagement-score',
					targetField: 'normalizedEngagement',
					value: {
						kind: 'arithmetic',
						op: 'multiply',
						left: {
							kind: 'convert',
							to: 'number',
							value: { kind: 'input', path: 'engagementScore' },
						},
						right: { kind: 'number', value: 1.2 },
					},
					teaching: {
						what: '把字符串参与度转换为数字，并乘以课堂权重 1.2。',
						why: '把 AI 代码里的类型转换和算术表达式变成可阅读、可编辑的积木。',
						editable: ['输入字段 engagementScore', '类型转换 number', '倍率 1.2'],
						expectedEffect: '得到统一数值口径的 normalizedEngagement。',
					},
				},
				{
					kind: 'set',
					intentStepId: 'logic.select-active-students',
					targetField: 'activeStudentNames',
					value: {
						kind: 'arrayMapPath',
						path: 'profile.name',
						array: {
							kind: 'arrayFilterPath',
							array: { kind: 'input', path: 'students' },
							path: 'active',
							op: 'eq',
							value: { kind: 'boolean', value: true },
						},
					},
					teaching: {
						what: '筛选 active 为 true 的学员，再映射读取 profile.name。',
						why: '让学员看见数组筛选与字段映射如何取代手写循环。',
						editable: ['数组路径 students', '筛选字段 active', '姓名路径 profile.name'],
						expectedEffect: 'activeStudentNames 只包含小林和小陈。',
					},
				},
			],
		},
		{
			nodeRef: 'logic.compose-explanation-card',
			label: '生成课堂解释卡片',
			outputMode: 'copyInput',
			statements: [
				{
					kind: 'set',
					intentStepId: 'logic.choose-classroom-gate',
					targetField: 'classroomGate',
					value: {
						kind: 'conditional',
						condition: {
							kind: 'compare',
							op: 'gte',
							left: { kind: 'input', path: 'normalizedEngagement' },
							right: { kind: 'number', value: 80 },
						},
						whenTrue: { kind: 'text', value: '可进入机器人计划讲解' },
						whenFalse: { kind: 'text', value: '先复盘课堂输入质量' },
					},
					teaching: {
						what: '用阈值 80 把规范化参与度转成课堂讲解分支。',
						why: '展示条件判断在 Blockly 中的输入、比较和两个可解释结果。',
						editable: ['阈值 80', '通过提示', '复盘提示'],
						expectedEffect: '本案例输出“可进入机器人计划讲解”。',
					},
				},
				{
					kind: 'set',
					intentStepId: 'logic.compose-explanation-card',
					targetField: 'explanationCard',
					value: {
						kind: 'join',
						values: [
							{ kind: 'text', value: '输入参与度已规范化为 ' },
							{
								kind: 'convert',
								to: 'text',
								value: { kind: 'input', path: 'normalizedEngagement' },
							},
							{ kind: 'text', value: '；已识别 ' },
							{
								kind: 'convert',
								to: 'text',
								value: {
									kind: 'arrayLength',
									array: { kind: 'input', path: 'activeStudentNames' },
								},
							},
							{ kind: 'text', value: ' 名活跃学员。' },
						],
					},
					teaching: {
						what: '把数值、数组长度和中文提示拼成一张课堂解释卡片。',
						why: '让学员同时看到数据如何成为面向人的说明，而非停留在代码变量。',
						editable: ['中文提示文本', '要显示的字段', '名单计数来源'],
						expectedEffect: '输出“输入参与度已规范化为 93.6；已识别 2 名活跃学员。”',
					},
				},
			],
		},
	],
	robotPlan: {
		schemaVersion: 1,
		planRef: 'plan.observe-greet-safe-return',
		label: '观察、问候并回安全位',
		robotProfileRef: catalog.robotName,
		catalogDigest: catalog.configDigest,
		budgetSec: 120,
		steps: [
			{
				stepRef: 'robot.inspect-scene',
				kind: 'skill',
				name: 'inspect_scene',
				teaching: {
					what: '先观察讲台区域。',
					why: '把“先看清环境再动作”的前置条件显式放入计划。',
					editable: [],
					expectedEffect: '形成后续技能可读取的场景状态。',
				},
			},
			{
				stepRef: 'robot.pause-for-explanation',
				kind: 'wait',
				durationMs: 500,
				teaching: {
					what: '停顿半秒，留出讲解与状态观察时间。',
					why: '说明计划中的等待也是可见、可审查的一步。',
					editable: ['等待时长'],
					expectedEffect: '在计划中保留 0.5 秒等待步骤。',
				},
			},
			{
				stepRef: 'robot.wave-classroom',
				kind: 'skill',
				name: 'wave_hello',
				when: { field: 'last.success', op: 'eq', value: true },
				teaching: {
					what: '仅在上一步成功后执行问候。',
					why: '把运行守卫写进 Blockly 计划，而把全局分支留给 n8n。',
					editable: ['技能 wave_hello', '上一步成功条件'],
					expectedEffect: '观察失败时，问候技能被跳过。',
				},
			},
			{
				stepRef: 'robot.return-safe-pose',
				kind: 'skill',
				name: 'recover_safe_pose',
				when: { field: 'last.success', op: 'eq', value: true },
				teaching: {
					what: '在问候后回到安全位。',
					why: '让学员看见动作收尾也属于可审核计划的一部分。',
					editable: ['技能 recover_safe_pose', '上一步成功条件'],
					expectedEffect: '最后一步在前序成功时请求安全回位。',
				},
			},
		],
	},
};

const result = generateCompetitionDesign(draft, {
	catalog,
	robotCredential: {
		id: 'REPLACE_WITH_ROBOFRAME_CREDENTIAL_ID',
		name: 'REPLACE_WITH_ROBOFRAME_CREDENTIAL_NAME',
	},
});

if (!result.ok) throw new Error(JSON.stringify(result, null, 2));

const workflow = structuredClone(result.artifact.n8nWorkflow);
workflow.id = 'demo.ai-explainable-robot-classroom';
workflow.name = draft.name;
workflow.active = false;
workflow.settings = {};

insertInitialInputNode(workflow, initialInput);
localizeWorkflow(workflow);

const expectedBlocklyOutput = {
	...initialInput,
	normalizedEngagement: 93.6,
	activeStudentNames: ['小林', '小陈'],
	classroomGate: '可进入机器人计划讲解',
	explanationCard: '输入参与度已规范化为 93.6；已识别 2 名活跃学员。',
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
	writeJson('ai-explainable-robot-classroom.design-draft.json', draft),
	writeJson('ai-explainable-robot-classroom.workflow.json', workflow),
	writeJson('initial-classroom-input.json', initialInput),
	writeJson('expected-blockly-output.json', expectedBlocklyOutput),
	writeJson('ai-explainable-robot-classroom.artifact-summary.json', {
		schemaVersion: result.artifact.schemaVersion,
		designId: result.artifact.designId,
		revisionId: result.artifact.revisionId,
		catalogDigest: result.artifact.catalogDigest,
		n8nNodeCount: workflow.nodes.length,
		logicNodes: result.artifact.logicNodes,
		robotPlan: result.artifact.robotPlan,
		traceMap: result.artifact.traceMap,
		hardwareBoundary: {
			robotProfile: catalog.robotName,
			configDigest: catalog.configDigest,
			credentialReference: 'REPLACE_WITH_ROBOFRAME_CREDENTIAL_*',
			executionPrerequisites: [
				'目标 n8n 实例已绑定 RoboFrame Bridge API 凭据。',
				'Robot Status 返回 motionAuthorized=true 且 busy=false。',
				'Robot Validate 接受该计划与当前 live catalog digest。',
				'教师在 n8n 审批表单中选择“批准”。',
			],
		},
	}),
]);

process.stdout.write(
	`Generated ${workflow.nodes.length} n8n nodes, ${result.artifact.logicNodes.length} Blockly Logic workspaces, and ${result.artifact.robotPlan.plan.length} Robot Plan steps in ${outputDirectory}.\n`,
);

async function writeJson(name, value) {
	await writeFile(`${outputDirectory}/${name}`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function insertInitialInputNode(workflowToUpdate, input) {
	const start = workflowToUpdate.nodes.find((node) => node.type === 'n8n-nodes-base.manualTrigger');
	const firstLogic = workflowToUpdate.nodes.find((node) => node.type === 'CUSTOM.blocklyCode');
	if (start === undefined || firstLogic === undefined) {
		throw new Error('Generated workflow is missing its start or first Blockly Logic node');
	}

	const inputNode = {
		id: 'b6c3b3d4-2e10-51ef-b0c9-1f4960a083c0',
		name: '01.5 教学输入',
		type: 'n8n-nodes-base.set',
		typeVersion: 3.4,
		position: [224, 256],
		parameters: {
			options: {},
			assignments: {
				assignments: [
					{
						id: 'lesson-object',
						name: 'lesson',
						type: 'object',
						value: JSON.stringify(input.lesson),
					},
					{
						id: 'engagement-score',
						name: 'engagementScore',
						type: 'string',
						value: input.engagementScore,
					},
					{
						id: 'students-array',
						name: 'students',
						type: 'array',
						value: JSON.stringify(input.students),
					},
					{
						id: 'teacher-object',
						name: 'teacher',
						type: 'object',
						value: JSON.stringify(input.teacher),
					},
					{
						id: 'robot-task-object',
						name: 'robotTask',
						type: 'object',
						value: JSON.stringify(input.robotTask),
					},
				],
			},
		},
		notes: '提供确定的课堂输入，便于讲解 Blockly 逻辑的预期输出。',
		notesInFlow: true,
	};

	const startIndex = workflowToUpdate.nodes.indexOf(start);
	workflowToUpdate.nodes.splice(startIndex + 1, 0, inputNode);
	workflowToUpdate.connections[start.name] = {
		main: [[{ node: inputNode.name, type: 'main', index: 0 }]],
	};
	workflowToUpdate.connections[inputNode.name] = {
		main: [[{ node: firstLogic.name, type: 'main', index: 0 }]],
	};
}

function localizeWorkflow(workflowToUpdate) {
	const names = new Map([
		['01 Start', '01 开始课堂演示'],
		['01.5 教学输入', '02 准备课堂输入'],
		['01.1 Blockly Logic · 规范化课堂输入', '03 Blockly · 规范化课堂数据'],
		['01.2 Blockly Logic · 生成课堂解释卡片', '04 Blockly · 生成解释卡片'],
		['02 Robot Status', '05 RoboFrame · 查询设备状态'],
		['03 Robot Ready?', '06 设备满足动作条件？'],
		['04 Robot Plan · plan.observe-greet-safe-return', '07 Blockly · 生成机器人计划'],
		['05 Validate Plan', '08 RoboFrame · 校验机器人计划'],
		['06 Human Approval', '09 教师确认（表单）'],
		['07 Approved?', '10 已获得教师批准？'],
		['08 Merge Approved Plan', '11 合并计划与批准结果'],
		['09 Execute Robot Plan', '12 RoboFrame · 执行计划'],
		['10 Task Completed?', '13 任务已完成？'],
		['11 Completed', '14 完成：进入执行回看'],
		['12 Needs Inspection', '15 待检查：查看结构化结果'],
		['13 Rejected', '16 已驳回：保留计划，不执行'],
		['14 Robot Not Ready', '17 设备未就绪：停在课堂讲解'],
	]);

	for (const node of workflowToUpdate.nodes) {
		const translatedName = names.get(node.name);
		if (translatedName !== undefined) node.name = translatedName;
	}

	const translatedConnections = {};
	for (const [source, outputs] of Object.entries(workflowToUpdate.connections)) {
		translatedConnections[names.get(source) ?? source] = Object.fromEntries(
			Object.entries(outputs).map(([outputType, branches]) => [
				outputType,
				branches.map((branch) =>
					branch.map((connection) => ({
						...connection,
						node: names.get(connection.node) ?? connection.node,
					})),
				),
			]),
		);
	}
	workflowToUpdate.connections = translatedConnections;

	const positions = new Map([
		['01 开始课堂演示', [0, 256]],
		['02 准备课堂输入', [224, 256]],
		['03 Blockly · 规范化课堂数据', [448, 256]],
		['04 Blockly · 生成解释卡片', [672, 256]],
		['05 RoboFrame · 查询设备状态', [896, 256]],
		['06 设备满足动作条件？', [1120, 256]],
		['07 Blockly · 生成机器人计划', [1344, 96]],
		['08 RoboFrame · 校验机器人计划', [1568, 96]],
		['09 教师确认（表单）', [1792, 32]],
		['10 已获得教师批准？', [2016, 32]],
		['11 合并计划与批准结果', [2240, 48]],
		['12 RoboFrame · 执行计划', [2464, 48]],
		['13 任务已完成？', [2688, 48]],
		['14 完成：进入执行回看', [2912, 0]],
		['15 待检查：查看结构化结果', [2912, 192]],
		['16 已驳回：保留计划，不执行', [2240, 240]],
		['17 设备未就绪：停在课堂讲解', [1344, 288]],
	]);
	for (const node of workflowToUpdate.nodes) {
		const position = positions.get(node.name);
		if (position !== undefined) node.position = position;
	}

	const approval = workflowToUpdate.nodes.find((node) => node.type === 'n8n-nodes-base.wait');
	if (approval === undefined) throw new Error('Generated workflow is missing the approval form');
	approval.parameters.formTitle = '教师确认机器人计划';
	approval.parameters.formDescription =
		'请先核对 Blockly 机器人计划、校验结果和设备状态；选择“批准”才会进入 RoboFrame 执行。';
	approval.parameters.formFields.values = [
		{
			fieldLabel: '教师确认',
			fieldType: 'radio',
			fieldOptions: { values: [{ option: '批准' }, { option: '驳回' }] },
			requiredField: true,
		},
	];

	const approvalDecision = workflowToUpdate.nodes.find(
		(node) => node.name === '10 已获得教师批准？',
	);
	if (approvalDecision === undefined)
		throw new Error('Generated workflow is missing the approval gate');
	approvalDecision.parameters.conditions.conditions[0].leftValue = '={{ $json["教师确认"] }}';
	approvalDecision.parameters.conditions.conditions[0].rightValue = '批准';

	const notes = new Map([
		['01 开始课堂演示', 'n8n 负责启动整条教学编排。'],
		['03 Blockly · 规范化课堂数据', '在节点内部用积木表达类型转换、乘法、筛选与字段映射。'],
		['04 Blockly · 生成解释卡片', '把计算结果转成学员和教师都能理解的中文说明。'],
		['07 Blockly · 生成机器人计划', '这里生成 RobotTaskPlan；此节点只编译计划，不提交实机动作。'],
		['08 RoboFrame · 校验机器人计划', '用当前 bridge catalog、计划摘要和规则校验计划。'],
		['09 教师确认（表单）', '教师批准是进入 Robot Task 的显式前提。'],
		['12 RoboFrame · 执行计划', '只在设备就绪、校验通过和教师批准后向 RoboFrame 提交步骤。'],
		['14 完成：进入执行回看', '查看 n8n execution 中的 taskIds、steps 与 finalStatus。'],
		['15 待检查：查看结构化结果', '保留失败、取消或未知状态的结构化结果，供教师讲解。'],
		['16 已驳回：保留计划，不执行', '教师选择驳回时，计划保留在执行记录中，实机动作路径不继续。'],
		['17 设备未就绪：停在课堂讲解', '运动未授权或设备忙时，工作流停在此处。'],
	]);
	for (const node of workflowToUpdate.nodes) {
		const note = notes.get(node.name);
		if (note !== undefined) {
			node.notes = note;
			node.notesInFlow = true;
		}
	}
}

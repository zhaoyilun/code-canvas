/**
 * Robot3D：RoboFrame 技能目录的 3D 执行器。
 *
 * 数据流一句话：`@codecanvas/capabilities` 的真实目录 → 选中一个 capability →
 * 执行器按 implementation 逐条下发原语 → 机械臂动，日志逐条对上。
 *
 * 这里只剩**这个应用自己那套三栏界面**的接线：画面与执行能力本身在 `mount.ts` 里，
 * 那一层不依赖 `id="catalog" / id="run" / id="hud"` 任何一个元素，studio 也挂它。
 * 所以本文件的界面与深链行为**对外保持不变**，只是底下换成了同一个入口。
 *
 * 深链（自动化与自查用）：
 *   ?capability=wave_hello              打开就执行某个能力
 *   ?param.motion_direction=left&param.motion_distance=0.05   给它参数
 */
import './style.css';
import { ROBOFRAME_SO101_CATALOG as catalog, ROBOFRAME_SO101_PROVENANCE as provenance } from '@codecanvas/capabilities';
import { findPrimitive } from '@codecanvas/contracts';
import type { RunOutcome, StepEvent } from './roboframe/executor';
import { intake, planStepLabel, type PlanRunOutcome } from './roboframe/plan';
import { mountVirtualDevice } from './mount';
import { createPanel } from './ui/panel';

const host = document.getElementById('stage');
if (!(host instanceof HTMLElement)) throw new Error('缺少舞台容器');

// 画面 + 机械臂 + 执行器 + 队列，全在这个入口里；本文件只负责把它接到自己的三栏界面上
const device = mountVirtualDevice(host, { catalog });
const { rig } = device;

// 先建步骤账本：执行器的 onStep 要往里记，界面也照着它渲染
const steps: StepEvent[] = [];
device.onStep((event) => panel.appendStep(event));
let lastOutcome: RunOutcome | null = null;
let lastPlan: { outcome: PlanRunOutcome; json: string } | null = null;

const panel = createPanel(catalog, provenance, {
	onSelect: (capability) => {
		// 只换选中项，**不动日志**：点一个技能就把历史清掉，看起来像"从头开始"
		panel.setSelected(capability.capabilityRef);
	},
	onRun: (capabilityRef, params) =>
		enqueueCapability(catalog.capabilities.find((c) => c.capabilityRef === capabilityRef) ?? null, params),
	onCancel: () => {
		device.cancel();
		panel.setStatus('已请求取消', 'bad');
	},
	onValidateJson: (text) => void validateJson(text),
	onRunJson: (text) => void runJson(text),
	onReset: () => {
		device.reset();
		panel.clearSteps();
		panel.setStatus('已复位到零位，日志清空');
	},
	onClearQueue: () => {
		device.clearQueue();
		panel.setStatus('已清空队列里等待的指令');
	},
});

// 队列条与队列异常：账本归 mount 管，界面这两处是本地表现
device.onQueue((state) => panel.setQueue(state.running, state.queued));
device.onQueueError((message) => panel.setStatus(message, 'bad'));

let selectedRef = '';

const formatJoints = (joints: Record<string, number>): string =>
	Object.values(joints)
		.map((v) => v.toFixed(3))
		.join('  ');

const paramFromUrl = (): Record<string, string> => {
	const out: Record<string, string> = {};
	new URLSearchParams(location.search).forEach((value, key) => {
		if (key.startsWith('param.')) out[key.slice('param.'.length)] = value;
	});
	return out;
};

/**
 * 入队一个能力，返回它在**轮到自己跑完之后**的结局（自动化用；清空队列会丢掉没跑的）。
 * 起始姿态在真正执行时才记（排队期间机械臂还在动，早算没有意义）。
 */
async function enqueueCapability(
	capability: (typeof catalog.capabilities)[number] | null,
	params: Record<string, string>,
): Promise<RunOutcome | null> {
	if (!capability) return null;
	steps.length = 0; // 账本从这一条开始记（排队期间不动它）
	panel.appendNote(`▶ 执行 ${capability.label}（${capability.capabilityRef}）`);
	panel.appendNote(`  起始姿态 ${formatJoints(rig.poseJoints())}`);
	panel.setStatus(`执行 ${capability.label} …`, 'busy');
	const result = await device.runCapability(capability.capabilityRef, params);
	if (result === null) return null;
	lastOutcome = result.outcome;
	steps.push(...result.outcome.steps);
	panel.setStatus(
		lastOutcome.ok ? `完成：${capability.label}（${lastOutcome.steps.length} 条原语）` : `未完成：${lastOutcome.reason ?? ''}`,
		lastOutcome.ok ? 'idle' : 'bad',
	);
	return lastOutcome;
}

/** 校验一段 JSON：诊断原样交给界面（契约负责判，这里只做转交） */
async function validateJson(text: string): Promise<ReturnType<typeof intake>> {
	const result = intake(text, catalog);
	panel.setDiagnostics(result.ok ? [] : result.diagnostics);
	return result;
}

/** 跑一份任务 JSON：技能计划，或 bridge 那种单条指令（同样入队，排在别的指令后面） */
async function runJson(text: string): Promise<void> {
	const result = await validateJson(text);
	if (!result.ok) {
		panel.setStatus(`JSON 没通过校验（${String(result.diagnostics.length)} 条诊断）`, 'bad');
		return;
	}
	const plan = result.plan;
	panel.appendNote(`▶ 执行计划：${plan.description ?? '(未命名)'}（${String(plan.plan.length)} 步）`);
	panel.appendNote(`  起始姿态 ${formatJoints(rig.poseJoints())}`);
	panel.setStatus(`执行计划：${plan.description ?? '(未命名)'}`, 'busy');
	// 计划步那几行由 mount 的账本推过来：一条计划步一个结论，不再收 running
	const off = device.onStep((event) => {
		if (event.state !== 'done' && event.state !== 'failed') return;
		/*
		 * 这一步在日志里叫什么：跑技能时是能力名；跑**原语**时（`primitive` 步）没有能力可指，
		 * 报的是目录里那个原语的标签（「张开夹爪」）——查不到就退回原语名，不编一个中文名。
		 */
		const name = event.capabilityRef ?? (findPrimitive(catalog, event.primitiveRef)?.label ?? event.primitiveRef);
		panel.appendPlanStep({
			index: event.index,
			total: event.total,
			skill: name,
			taskId: '',
			state: event.state,
		});
	});
	/*
	 * 等待步要在这儿自己补一行：技能步的原语事件已经把行写出来了，而等待步**什么都不下发**——
	 * 不补它，那两秒在日志里就是一段没有解释的空白（`running` 也收，面板把同一步翻面而不是添一行）。
	 * 其余计划步不在这里补：它们各有原语事件，两处都写就会出现两份同一句话。
	 */
	const offWait = device.onPlanStep((event) => {
		if (event.step.step !== 'wait') return;
		panel.appendPlanStep({
			index: event.index,
			total: event.total,
			skill: planStepLabel(event.step),
			taskId: '',
			state: event.state,
		});
	});
	const result2 = await device.enqueuePlan(plan);
	off();
	offWait();
	if (result2.plan === undefined) return;
	lastPlan = { outcome: result2.plan, json: text };
	panel.setStatus(
		result2.plan.ok
			? `计划完成：${String(result2.plan.completed)}/${String(result2.plan.total)} 步`
			: `计划中断：第 ${String(result2.plan.completed + 1)} 步没做成 —— ${result2.plan.reason ?? ''}`,
		result2.plan.ok ? 'idle' : 'bad',
	);
}

// 选中：URL 指定的能力优先，否则第一个
const requested = new URLSearchParams(location.search).get('capability');
const initial = catalog.capabilities.find((c) => c.capabilityRef === requested) ?? catalog.capabilities[0];
if (initial) {
	selectedRef = initial.capabilityRef;
	panel.setSelected(selectedRef);
}

// 每帧：机械臂由 mount 的渲染循环推进，这里只跟着刷 HUD（HUD 只报实测值：关节角与指尖位置）
let hudTimer = 0;
device.onFrame((dt) => {
	hudTimer += dt;
	if (hudTimer <= 0.1) return;
	hudTimer = 0;
	const joints = rig.poseJoints();
	const tip = rig.toolPosition();
	panel.setHud([
		`关节(rad) ${Object.values(joints).map((v) => v.toFixed(3)).join('  ')}`,
		`指尖(base 系, m) x=${tip.x.toFixed(3)} y=${tip.y.toFixed(3)} z=${tip.z.toFixed(3)}`,
		`目录 ${catalog.catalogRef} · 上游 ${provenance.commit.slice(0, 8)}`,
	]);
});

// 自动化自查用：暴露目录、运行入口与实测读数
declare global {
	interface Window {
		__ROBOT3D__?: Record<string, unknown>;
	}
}
window.__ROBOT3D__ = {
	catalogRef: catalog.catalogRef,
	capabilities: catalog.capabilities.map((c) => c.capabilityRef),
	stages: () => ({}),
	poses: () => rig.poseJoints(),
	tip: () => rig.toolPosition(),
	steps: () => steps,
	lastOutcome: () => lastOutcome,
	lastPlan: () => lastPlan,
	validateJson: (json: string) => {
		const result = intake(json, catalog);
		return { ok: result.ok, codes: result.ok ? [] : result.diagnostics.map((d) => d.code) };
	},
	runTask: (json: string | object) => runJson(typeof json === 'string' ? json : JSON.stringify(json)),
	runSequence: (refs: string[]) => {
		runSequence(refs);
	},
	queueState: () => device.queueState,
	resetRig: () => device.reset(),
	run: async (ref: string, params: Record<string, string> = {}) => {
		const capability = catalog.capabilities.find((c) => c.capabilityRef === ref) ?? null;
		selectedRef = ref;
		return await enqueueCapability(capability, params);
	},
};

/** 连续跑多个能力：?capabilities=inspect_scene,wave_hello —— 全部入队，串行跑 */
function runSequence(refs: string[]): void {
	for (const ref of refs) {
		const capability = catalog.capabilities.find((c) => c.capabilityRef === ref.trim());
		if (!capability) {
			panel.setStatus(`目录里没有技能 ${ref}`, 'bad');
			continue;
		}
		selectedRef = capability.capabilityRef;
		panel.setSelected(capability.capabilityRef);
		enqueueCapability(capability, {});
	}
}

// 深链：打开就跑
const sequenceFromUrl = new URLSearchParams(location.search).get('capabilities');
const taskFromUrl = new URLSearchParams(location.search).get('task');
if (sequenceFromUrl !== null) {
	void runSequence(sequenceFromUrl.split(','));
} else if (taskFromUrl !== null) {
	// ?task=<URL 编码的 JSON>：贴一条指令就执行
	void runJson(decodeURIComponent(taskFromUrl));
} else if (requested) {
	void enqueueCapability(initial ?? null, paramFromUrl());
}

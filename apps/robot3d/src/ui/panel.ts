/**
 * 界面：左边是设备目录（照目录渲染，不写死技能名），右边是这次运行的语句与结果。
 *
 * 界面上出现的每个技能、每个参数、每句实现都来自 `CapabilityCatalog`；
 * 只有「本执行器的映射说明」那几行是本地知识，单独放在底部并标明。
 */
import type { CapabilityCatalog, CapabilitySpec } from '@codecanvas/contracts';
import type { CatalogProvenance } from '@codecanvas/capabilities';
import type { StepEvent } from '../roboframe/executor';
import { NAMED_POSES } from '../roboframe/poses';
import { SAMPLE_PLAN_JSON } from '../roboframe/plan';
import { dimensionsSource } from '../scene/so101';

export interface PanelHooks {
	onSelect(capability: CapabilitySpec): void;
	onRun(capabilityRef: string, params: Record<string, string>): void;
	onCancel(): void;
	onValidateJson(text: string): void;
	onRunJson(text: string): void;
	onReset(): void;
	onClearQueue(): void;
}

export interface PlanStepView {
	readonly index: number;
	readonly total: number;
	readonly skill: string;
	readonly taskId: string;
	readonly state: 'running' | 'done' | 'failed';
}

export interface Panel {
	setSelected(ref: string): void;
	appendStep(event: StepEvent): void;
	appendPlanStep(view: PlanStepView): void;
	appendNote(text: string): void;
	clearSteps(): void;
	setStatus(text: string, tone?: 'idle' | 'busy' | 'bad'): void;
	setHud(lines: string[]): void;
	setJson(text: string): void;
	getJson(): string;
	setDiagnostics(items: readonly { code: string; severity: string; message: string; path?: string }[]): void;
	setQueue(running: string | null, queued: readonly string[]): void;
}

const GROUP_OF: { test: RegExp; title: string }[] = [
	{ test: /^(inspect|recover)_/, title: '观察与复位' },
	{ test: /(gripper|rotate_gripper)/, title: '夹爪与手腕' },
	{ test: /^move_relative_ee$/, title: '相对移动' },
	{ test: /^(dance|wave|nod|shake|celebrate|greet|act|happy)/, title: '手势' },
];

function groupOf(capability: CapabilitySpec): string {
	for (const g of GROUP_OF) if (g.test.test(capability.capabilityRef)) return g.title;
	return '其他';
}

function summarizeArgs(args: Record<string, unknown>, maxLength = Number.POSITIVE_INFINITY): string {
	const text = Object.entries(args)
		.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
		.join(' ');
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function createPanel(
	catalog: CapabilityCatalog,
	provenance: CatalogProvenance,
	hooks: PanelHooks,
): Panel {
	const catalogEl = document.getElementById('catalog');
	const runEl = document.getElementById('run');
	const hudEl = document.getElementById('hud');
	if (!catalogEl || !runEl || !hudEl) throw new Error('缺少面板容器');

	// ---- 左栏：设备与目录 -------------------------------------------------
	const header = document.createElement('div');
	header.innerHTML = `
		<p class="cc-title">RoboFrame 能力目录</p>
		<h1 class="cc-robot"></h1>
		<p class="cc-meta" id="prov"></p>`;
	header.querySelector('.cc-robot')!.textContent = catalog.displayName;
	header.querySelector('#prov')!.textContent =
		`${catalog.catalogRef}\nrevision ${catalog.revisionRef}\n上游 ${provenance.upstream.split('//')[1] ?? provenance.upstream} @ ${provenance.commit.slice(0, 8)}\n命名位姿 ${(catalog.namedPoses ?? []).join(' / ')}`;
	catalogEl.append(header);

	const groups = new Map<string, HTMLDivElement>();
	const buttons = new Map<string, HTMLButtonElement>();
	for (const capability of catalog.capabilities) {
		const title = groupOf(capability);
		let group = groups.get(title);
		if (!group) {
			group = document.createElement('div');
			group.className = 'cc-group';
			const h = document.createElement('h3');
			h.textContent = title;
			group.append(h);
			catalogEl.append(group);
			groups.set(title, group);
		}
		const button = document.createElement('button');
		button.className = 'cc-cap';
		button.type = 'button';
		button.setAttribute('aria-pressed', 'false');
		const strong = document.createElement('b');
		strong.textContent = capability.label;
		const ref = document.createElement('span');
		ref.textContent = capability.capabilityRef;
		button.append(strong, ref);
		button.addEventListener('click', () => {
			for (const b of buttons.values()) b.setAttribute('aria-pressed', 'false');
			button.setAttribute('aria-pressed', 'true');
			hooks.onSelect(capability);
		});
		group.append(button);
		buttons.set(capability.capabilityRef, button);
	}

	const note = document.createElement('p');
	note.className = 'cc-note';
	note.textContent = `连杆长度来源：${dimensionsSource === 'approximate' ? '近似（真值在 robot_description 的 URDF 里）' : dimensionsSource}。执行器映射见右栏底部。`;
	catalogEl.append(note);

	// ---- 右栏：实现预览 + 参数 + 运行 ------------------------------------
	const selectedTitle = document.createElement('p');
	selectedTitle.className = 'cc-title';
	selectedTitle.textContent = '实现（目录原文）';
	const implEl = document.createElement('pre');
	implEl.className = 'cc-body';
	const paramsEl = document.createElement('div');
	paramsEl.className = 'cc-group';

	const actions = document.createElement('div');
	actions.className = 'cc-actions';
	const runButton = document.createElement('button');
	runButton.type = 'button';
	runButton.className = 'cc-btn cc-btn-primary';
	runButton.textContent = '执行';
	runButton.disabled = true;
	const cancelButton = document.createElement('button');
	cancelButton.type = 'button';
	cancelButton.className = 'cc-btn';
	cancelButton.textContent = '取消';
	cancelButton.disabled = true;
	const resetButton = document.createElement('button');
	resetButton.type = 'button';
	resetButton.className = 'cc-btn';
	resetButton.textContent = '复位';
	resetButton.title = '关节归零、夹爪张开（目录里也有 recover_zero_pose 这个技能）';
	actions.append(runButton, cancelButton, resetButton);

	const status = document.createElement('p');
	status.className = 'cc-hudline';
	status.textContent = '未选择能力';

	// 队列条：显示正在跑的与排队的，点几下就排几条，不再"忙就忽略"
	const queueBar = document.createElement('div');
	queueBar.className = 'cc-queue';
	const queueText = document.createElement('span');
	queueText.className = 'cc-queue-text';
	const queueClear = document.createElement('button');
	queueClear.type = 'button';
	queueClear.className = 'cc-btn cc-btn-mini';
	queueClear.textContent = '清空队列';
	queueClear.addEventListener('click', () => hooks.onClearQueue());
	queueBar.append(queueText, queueClear);

	const logTitle = document.createElement('p');
	logTitle.className = 'cc-title';
	logTitle.textContent = '运行日志（原语逐条）';
	const logEl = document.createElement('div');
	logEl.className = 'cc-group';

	const mapping = document.createElement('p');
	mapping.className = 'cc-note';
	mapping.textContent =
		'本执行器映射：关节 1→肩回转 2→肩抬升 3→肘 4→腕俯仰 5→工具自转；' +
		'相对移动 up/down=±z、left/right=±y、forward/back=±x（基座系，米）；' +
		`命名位姿来源：${Object.entries(NAMED_POSES)
			.map(([k, v]) => `${k}=${v.source}`)
			.join('、')}；轨迹模板按 t=i/拍数 归一化（本仓库口径）。`;

	// ---- JSON 指令：贴一份任务 JSON 进来就跑 ---------------------------------
	const jsonTitle = document.createElement('p');
	jsonTitle.className = 'cc-title';
	jsonTitle.textContent = 'JSON 指令（技能计划 / 单条指令）';
	const jsonArea = document.createElement('textarea');
	jsonArea.className = 'cc-json';
	jsonArea.spellcheck = false;
	jsonArea.rows = 8;
	jsonArea.setAttribute('aria-label', '任务 JSON');
	const jsonActions = document.createElement('div');
	jsonActions.className = 'cc-actions';
	const sampleButton = document.createElement('button');
	sampleButton.type = 'button';
	sampleButton.className = 'cc-btn';
	sampleButton.textContent = '载入示例';
	const validateButton = document.createElement('button');
	validateButton.type = 'button';
	validateButton.className = 'cc-btn';
	validateButton.textContent = '校验';
	const runJsonButton = document.createElement('button');
	runJsonButton.type = 'button';
	runJsonButton.className = 'cc-btn cc-btn-primary';
	runJsonButton.textContent = '执行 JSON';
	jsonActions.append(sampleButton, validateButton, runJsonButton);
	const diagnosticsEl = document.createElement('div');
	diagnosticsEl.className = 'cc-diag';
	jsonArea.value = SAMPLE_PLAN_JSON;
	runEl.append(jsonTitle, jsonArea, jsonActions, diagnosticsEl);
	runEl.append(selectedTitle, implEl, paramsEl, actions, queueBar, status, logTitle, logEl, mapping);

	sampleButton.addEventListener('click', () => {
		jsonArea.value = SAMPLE_PLAN_JSON;
		diagnosticsEl.replaceChildren();
	});
	validateButton.addEventListener('click', () => hooks.onValidateJson(jsonArea.value));
	runJsonButton.addEventListener('click', () => hooks.onRunJson(jsonArea.value));

	let current: CapabilitySpec | null = null;
	let activeRow: HTMLElement | null = null;
	let planRow: HTMLElement | null = null;
	/** 连续跑会一直往下堆，超过上限从最早的开始丢，别把页面拖死 */
	const trimLog = (): void => {
		while (logEl.childElementCount > 240) logEl.firstElementChild?.remove();
	};
	const inputs = new Map<string, HTMLInputElement>();

	function renderParams(capability: CapabilitySpec): void {
		paramsEl.replaceChildren();
		inputs.clear();
		if (capability.parameters.length === 0) {
			const p = document.createElement('p');
			p.className = 'cc-note';
			p.textContent = '这个能力没有参数。';
			paramsEl.append(p);
			return;
		}
		const title = document.createElement('h3');
		title.textContent = '参数';
		paramsEl.append(title);
		for (const param of capability.parameters) {
			const field = document.createElement('div');
			field.className = 'cc-field';
			const label = document.createElement('label');
			label.textContent = `${param.label}（${param.name}: ${param.type}）`;
			const input = document.createElement('input');
			input.type = param.type === 'number' ? 'number' : 'text';
			input.step = param.type === 'number' ? 'any' : '';
			// 目录里的 string 参数是枚举语义（up/down/left/right），给个提示值
			if (param.name === 'motion_direction') input.value = 'up';
			if (param.name === 'motion_distance') input.value = '0.04';
			label.htmlFor = `param-${param.name}`;
			input.id = label.htmlFor;
			field.append(label, input);
			paramsEl.append(field);
			inputs.set(param.name, input);
		}
	}

	runButton.addEventListener('click', () => {
		if (!current) return;
		const params: Record<string, string> = {};
		for (const [name, input] of inputs) params[name] = input.value;
		// 把技能名一起交出去：执行侧不必再自己维护一份"当前选中是谁"的影子状态
		// （那份影子状态漏更新过一次，三条队列全变成了同一个技能）
		hooks.onRun(current.capabilityRef, params);
	});
	cancelButton.addEventListener('click', () => hooks.onCancel());
	resetButton.addEventListener('click', () => hooks.onReset());

	return {
		setSelected(ref: string) {
			const capability = catalog.capabilities.find((c) => c.capabilityRef === ref);
			if (!capability) return;
			current = capability;
			selectedTitle.textContent = `实现 · ${capability.label}（${capability.capabilityRef}）`;
			implEl.textContent = capability.implementation
				.map((s, i) => {
					if (s.kind === 'call') return `${i + 1}. ${s.primitiveRef}(${summarizeArgs(s.arguments)})`;
					if (s.kind === 'set') return `${i + 1}. set ${s.target}`;
					return `${i + 1}. if …`;
				})
				.join('\n');
			const summary = capability.summary ? `\n\n${capability.summary}` : '';
			implEl.textContent += summary;
			renderParams(capability);
			runButton.disabled = false;
			cancelButton.disabled = false;
			status.textContent = '就绪';
		},
		appendStep(event: StepEvent) {
			const row = document.createElement('div');
			row.className = 'cc-step';
			const idx = document.createElement('span');
			idx.className = 'cc-step-idx';
			idx.textContent = `${event.index}/${event.total}`;
			const main = document.createElement('span');
			main.className = 'cc-step-main';
			// 日志里长参数（轨迹模板那种）截断显示；完整原文在右上「实现」里
			main.innerHTML = `${event.primitiveRef} <em>${summarizeArgs(event.args, 96).replace(/</g, '&lt;')}</em>${
				event.detail ? ` — ${event.detail.replace(/</g, '&lt;')}` : ''
			}`;
			const state = document.createElement('span');
			state.className = 'cc-step-state';
			state.dataset['state'] = event.state;
			state.textContent = event.state;
			row.append(idx, main, state);
			// 一个原语只占一行：running 那行在原地翻成终态
			if (activeRow && event.state !== 'running') {
				activeRow.replaceWith(row);
				activeRow = null;
			} else {
				logEl.append(row);
				activeRow = event.state === 'running' ? row : null;
			}
			logEl.scrollTop = logEl.scrollHeight;
		},
		clearSteps() {
			logEl.replaceChildren();
			activeRow = null;
			planRow = null;
		},
		setQueue(running, queued) {
			const parts: string[] = [];
			if (running !== null) parts.push(`执行中：${running}`);
			if (queued.length > 0) parts.push(`排队（${String(queued.length)}）：${queued.join(' → ')}`);
			queueText.textContent = parts.length > 0 ? parts.join('　|　') : '空闲';
			queueBar.dataset['state'] = running !== null ? 'busy' : 'idle';
			queueClear.disabled = queued.length === 0;
		},
		setStatus(text: string, tone: 'idle' | 'busy' | 'bad' = 'idle') {
			status.textContent = text;
			status.style.color = tone === 'bad' ? 'var(--cc-danger)' : tone === 'busy' ? 'var(--cc-accent)' : 'var(--cc-text-dim)';
		},
		setHud(lines: string[]) {
			hudEl.innerHTML = lines.map((l) => `<p class="cc-hudline">${l}</p>`).join('');
		},
		setJson(text: string) {
			jsonArea.value = text;
		},
		getJson() {
			return jsonArea.value;
		},
		setDiagnostics(items) {
			diagnosticsEl.replaceChildren();
			if (items.length === 0) {
				const ok = document.createElement('p');
				ok.className = 'cc-note';
				ok.textContent = '校验通过：技能与参数都在目录里。';
				diagnosticsEl.append(ok);
				return;
			}
			for (const item of items) {
				const row = document.createElement('p');
				row.className = 'cc-diag-row';
				row.dataset['severity'] = item.severity;
				row.textContent = `${item.severity === 'error' ? '✕' : '!'} ${item.code}${item.path ? ` @ ${item.path}` : ''} — ${item.message}`;
				diagnosticsEl.append(row);
			}
		},
		appendNote(text) {
			const row = document.createElement('div');
			row.className = 'cc-note-row';
			row.textContent = text;
			logEl.append(row);
			activeRow = null;
			planRow = null;
			trimLog();
			logEl.scrollTop = logEl.scrollHeight;
		},
		appendPlanStep(view) {
			const text = `计划 ${String(view.index)}/${String(view.total)} · ${view.skill} · ${view.taskId}`;
			// 同一步的 running 那行翻成终态，别一个计划步占两行
			if (planRow && planRow.dataset['state'] === 'running' && planRow.textContent === text.replace(/ · (done|failed)$/, '')) {
				planRow.dataset['state'] = view.state;
				planRow.textContent = view.state === 'running' ? text : `${text} · ${view.state}`;
			} else {
				const row = document.createElement('div');
				row.className = 'cc-plan-step';
				row.dataset['state'] = view.state;
				row.textContent = text;
				logEl.append(row);
				planRow = row;
			}
			activeRow = null;
			logEl.scrollTop = logEl.scrollHeight;
		},
	};
}

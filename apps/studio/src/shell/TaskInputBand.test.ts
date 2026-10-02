// @vitest-environment happy-dom
/**
 * 上层输入带的验收：这是本阶段唯一的真实输入口。
 *
 * 1. 粘贴改过的任务 JSON → 转换 → 真相换掉（三个视图都是从真相派生的，所以它们一起刷新）；
 * 2. 非法值（distance = 0）→ 诊断摆在输入区下方，**真相不动**；
 * 3. 根本不是 JSON 的文本 → 解析诊断，同样不动真相；
 * 4. 拖入 .json 文件 → 走的是同一条路（读文本 → `loadTaskJson`）；
 * 5. 失败路径不弹窗（诊断是给人看的，alert 不是）。
 *
 * 「三个视图同屏刷新」这一条的完整版在真浏览器里跑（见交付报告），
 * 这里守的是它成立的前提：唯一入口 + 失败不动真相。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSampleTask, useStudioDocument } from '../state/document';
import { SAMPLE_TASK_JSON } from '../state/sample-task';
import TaskInputBand from './TaskInputBand.vue';

const doc = useStudioDocument();

const sample = (): Record<string, unknown> => JSON.parse(SAMPLE_TASK_JSON) as Record<string, unknown>;

/** 改一处人类可读文本 + 一处数值——转换后视图上这两处都该变。 */
const editedJson = (): string => {
	const task = sample();
	task.description = '换成新任务：先转再停';
	const steps = task.steps as Array<Record<string, unknown>>;
	const first = steps[0];
	if (first === undefined) throw new Error('sample task must have steps');
	first.linear = 0.25;
	steps.pop(); // 顺带少一步：节点数也要跟着变
	return JSON.stringify(task, null, 2);
};

/** 非法：distance = 0 越出 `0 < distance ≤ 2.0`，任务层校验器会拦。 */
const illegalJson = (): string => {
	const task = sample();
	const steps = task.steps as Array<Record<string, unknown>>;
	const sensor = steps[1];
	if (sensor === undefined) throw new Error('sample task must have the obstacle step');
	sensor.distance = 0;
	return JSON.stringify(task, null, 2);
};

const input = (wrapper: ReturnType<typeof mount>) =>
	wrapper.get<HTMLTextAreaElement>('[data-testid="task-json-input"]');
const statusText = (wrapper: ReturnType<typeof mount>): string =>
	wrapper.get('[data-testid="task-input-status"]').text();

const paste = async (wrapper: ReturnType<typeof mount>, text: string): Promise<void> => {
	await input(wrapper).setValue(text);
};

const dropFile = async (wrapper: ReturnType<typeof mount>, name: string, text: string): Promise<void> => {
	const file = new File([text], name, { type: 'application/json' });
	const event = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
	wrapper.get('[data-testid="task-input-band"]').element.dispatchEvent(event);
	await flushPromises();
};

beforeEach(() => {
	expect(loadSampleTask()).toBe(true);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('输入带 · 转换', () => {
	it('粘一份改过的任务 JSON 点转换 → 声明换掉，节点数与参数都跟着变', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;
		expect(before?.nodes).toHaveLength(4);
		expect(before?.meta.description).toBe('前进，遇障停止后转向');

		await paste(wrapper, editedJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		const after = doc.declaration.value;
		expect(after).not.toBe(before);
		expect(after?.meta.description).toBe('换成新任务：先转再停');
		expect(after?.nodes).toHaveLength(3);
		expect(after?.nodes[0]?.parameters.linear).toBe(0.25);
		expect(after?.digest).not.toBe(before?.digest);

		expect(statusText(wrapper)).toContain('已转换');
		expect(statusText(wrapper)).toContain('3 个节点');
		// 成功且无话可说时不该冒出诊断列表
		expect(wrapper.find('[data-testid="task-input-diagnostics"]').exists()).toBe(false);
	});

	it('非法值（distance = 0）→ 诊断摆在输入区下方，真相一个字节都不动', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await paste(wrapper, illegalJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(statusText(wrapper)).toContain('转换失败');
		const rows = wrapper.findAll('[data-testid="task-input-diagnostic"]');
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some((row) => row.text().includes('distance'))).toBe(true);
		// 诊断在输入区的**下方**（DOM 顺序，不是「也挤在这一带」）
		const intake = wrapper.get('.intake').element;
		const feedback = wrapper.get('[data-testid="task-input-feedback"]').element;
		expect(intake.compareDocumentPosition(feedback) & 4).toBeTruthy();

		expect(doc.declaration.value).toBe(before);
		expect(doc.declaration.value?.nodes).toHaveLength(4);
	});

	it('根本不是 JSON 的文本 → 解析诊断，真相不动', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await paste(wrapper, '这不是 JSON，是一句话。');
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(statusText(wrapper)).toContain('转换失败');
		expect(wrapper.get('[data-testid="task-input-diagnostics"]').text()).toContain(
			'task_import.json_parse_error',
		);
		expect(doc.declaration.value).toBe(before);
	});

	it('失败路径不弹窗：诊断在带子里，alert / confirm 一次都不响', async () => {
		const alert = vi.fn();
		const confirm = vi.fn();
		vi.stubGlobal('alert', alert);
		vi.stubGlobal('confirm', confirm);

		const wrapper = mount(TaskInputBand);
		await paste(wrapper, illegalJson());
		await wrapper.get('[data-testid="task-convert"]').trigger('click');

		expect(alert).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="task-input-diagnostics"]').exists()).toBe(true);
	});

	it('空输入时转换按钮是禁用的（没东西可转就别给假入口）', async () => {
		const wrapper = mount(TaskInputBand);
		const button = wrapper.get('[data-testid="task-convert"]');

		expect(button.attributes('disabled')).toBeUndefined();
		await wrapper.get('[data-testid="task-clear"]').trigger('click');
		expect(button.attributes('disabled')).toBeDefined();
	});
});

describe('输入带 · 拖入文件', () => {
	it('拖一个 .json 进来 → 读文本后走同一条转换路，三个视图的数据跟着变', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await dropFile(wrapper, 'task-obstacle.json', editedJson());

		expect(doc.declaration.value).not.toBe(before);
		expect(doc.declaration.value?.meta.description).toBe('换成新任务：先转再停');
		expect(doc.declaration.value?.nodes).toHaveLength(3);
		expect(statusText(wrapper)).toContain('已转换');
		// 读进来的文本落到输入框，看得见自己拖了什么
		expect(input(wrapper).element.value).toContain('换成新任务：先转再停');
		expect(wrapper.get('[data-testid="task-input-file"]').text()).toBe('task-obstacle.json');
	});

	it('拖进来的文件是非法的 → 同样只出诊断，真相不动', async () => {
		const wrapper = mount(TaskInputBand);
		const before = doc.declaration.value;

		await dropFile(wrapper, 'broken.json', illegalJson());

		expect(doc.declaration.value).toBe(before);
		expect(statusText(wrapper)).toContain('转换失败');
		expect(wrapper.findAll('[data-testid="task-input-diagnostic"]').length).toBeGreaterThan(0);
	});
});

describe('输入带 · 转译链指示', () => {
	it('静态链条把「上游生成、我们转三视图」说清楚', () => {
		const wrapper = mount(TaskInputBand);
		const chain = wrapper.get('[data-testid="translation-chain"]');

		expect(chain.text()).toContain('任务 JSON');
		expect(chain.text()).toContain('积木');
		expect(chain.text()).toContain('流程');
		expect(chain.text()).toContain('代码');
		expect(chain.findAll('.chain-arrow')).toHaveLength(1);
	});

	it('链条不冒充入口：它不带按钮，也不改真相', () => {
		const wrapper = mount(TaskInputBand);
		expect(wrapper.get('[data-testid="translation-chain"]').findAll('button')).toHaveLength(0);
		expect(wrapper.get('[data-testid="translation-chain"]').findAll('textarea')).toHaveLength(0);
	});
});

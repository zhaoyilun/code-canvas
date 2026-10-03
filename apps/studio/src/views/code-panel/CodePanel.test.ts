// @vitest-environment happy-dom
/**
 * 代码面板：显示**模型写的那一整段教学代码**，按节拍一行行铺开。
 *
 * 这一组守四件事：
 * 1. 行数与内容就是 `spec.code`（不做任何拼接、重排、缩进推算——这一栏的字全部来自模型）；
 * 2. 行号从 1 起，是这份代码自己的行号；
 * 3. 画不出来时照实说（**不留一个空格子**，也不退回旧的「从目录推的实现」）；
 * 4. **一个字都不写回声明**：面板挂载前后 digest 与节点一模一样。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkflowDigest } from '@codecanvas/contracts';
import { useStudioDocument } from '../../state/document';
import { codeLinesOf, runTeaching, useTeaching } from '../../state/teaching';
import CodePanel from './CodePanel.vue';
import {
	loadTeachingFixture,
	sseForSpec,
	sseResponse,
	SINGLE_BLOCK_SPEC,
	TEACHING_SPEC_FIXTURE,
} from '../../state/__fixtures__/teaching-spec';

const teaching = useTeaching();
const doc = useStudioDocument();
const realMatchMedia = window.matchMedia;
const wrappers: VueWrapper[] = [];

const stubReducedMotion = (): void => {
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: query.includes('prefers-reduced-motion'),
			media: query,
			onchange: null,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});
};

const mountPanel = (): VueWrapper => {
	const wrapper = mount(CodePanel);
	wrappers.push(wrapper);
	return wrapper;
};

afterEach(() => {
	for (const wrapper of wrappers.splice(0)) wrapper.unmount();
	vi.unstubAllGlobals();
	Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia });
});

describe('还没有代码时', () => {
	it('说清这一栏是什么，不留空白', () => {
		stubReducedMotion();
		const wrapper = mountPanel();
		expect(wrapper.get('[data-testid="code-panel-empty"]').text()).toContain('还没有代码');
		expect(wrapper.find('[data-testid="code-panel-lines"]').exists()).toBe(false);
	});
});

describe('代码到手之后', () => {
	beforeEach(async () => {
		stubReducedMotion();
		await loadTeachingFixture();
	});

	it('显示的就是 spec.code 的每一行，逐字一致（不拼接、不重排）', () => {
		const wrapper = mountPanel();
		const lines = wrapper.findAll('[data-testid="code-line"]');
		const expected = codeLinesOf(TEACHING_SPEC_FIXTURE.code);
		expect(lines).toHaveLength(expected.length);
		// 用 `textContent` 而不是 `text()`：后者会 trim，缩进就量不出来了——
		// 而缩进正是这段代码可读性的一半。
		expect(lines.map((line) => line.find('.cp-text').element.textContent)).toEqual(
			expected.map((line) => (line === '' ? ' ' : line)),
		);
	});

	it('行号从 1 起，是这份代码自己的行号', () => {
		const wrapper = mountPanel();
		const numbers = wrapper.findAll('.cp-no').map((element) => element.text());
		expect(numbers[0]).toBe('1');
		expect(numbers.at(-1)).toBe(String(codeLinesOf(TEACHING_SPEC_FIXTURE.code).length));
	});

	it('标题是这一份规格的名字，页脚说得出铺开进度', () => {
		const wrapper = mountPanel();
		expect(wrapper.get('[data-testid="code-panel-title"]').text()).toBe(TEACHING_SPEC_FIXTURE.title);
		const total = codeLinesOf(TEACHING_SPEC_FIXTURE.code).length;
		expect(wrapper.get('[data-testid="code-panel-progress"]').text()).toContain(`${String(total)} / ${String(total)} 行`);
	});

	it('每一行都挂着入场动画的类（与另外两栏同一套观感）', () => {
		const wrapper = mountPanel();
		expect(wrapper.findAll('li.cp-line').length).toBeGreaterThan(0);
	});

	it('这一栏一个字都不写回声明：挂载前后 digest 与节点一模一样', async () => {
		const before = doc.declaration.value;
		const digestBefore = before === null ? '' : computeWorkflowDigest(before);
		const wrapper = mountPanel();
		await wrapper.vm.$nextTick();

		expect(doc.declaration.value).toEqual(before);
		expect(doc.declaration.value?.digest).toBe(before?.digest);
		expect(digestBefore).toBe(before?.digest);
	});
});

describe('画不出来时', () => {
	it('照实说模型说了什么，而**不**退回从目录推的实现', async () => {
		stubReducedMotion();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sseResponse(sseForSpec(SINGLE_BLOCK_SPEC))),
		);
		await runTeaching();

		const wrapper = mountPanel();
		expect(wrapper.get('[data-testid="code-panel-failed"]').text()).toContain('模型没写出来');
		expect(wrapper.find('[data-testid="code-panel-lines"]').exists()).toBe(false);
		expect(teaching.spec.value).toBeNull();
	});
});

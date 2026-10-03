// @vitest-environment happy-dom
/**
 * 开局那一眼：**打开页面什么都不灌**，三个视图各自说「还没有」。
 *
 * 为什么单开一个文件量它：这件事的主语是**启动那一刻**（`App.vue` 挂载），
 * 而不是任何一个视图自己。这一组挂的就是真的 `App.vue` / `StudioShell`——从外壳到三张画布
 * 整条链，量的是「用户打开页面看到的第一眼」，不是拼出来的一个状态。
 *
 * ⚠ 三栏那一组挂 `StudioShell` 而不是 `App`：`App` 的整棵树里**右栏会建 3D 画布**
 * （`VirtualDevicePanel`），而 happy-dom 给不出 WebGL 上下文（`Error creating WebGL context.`）
 * ——那是**测试环境**的限制，不是这一版的问题。外壳那一层（`StudioShell`）正好就是三栏本身，
 * 而 `App.vue` 里除了 `startTeachingWatch()` 什么都没有，那一句由上面那条用例单独量。
 *
 * 这一条是导演定的：从前挂载时就 `loadSampleTask()`，于是三张画布上摆着一份
 * **用户没说过**的示例任务；空着（并且说清为什么空）比那更诚实。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.vue';
import StudioShell from './StudioShell.vue';
import { clearTeaching, useTeaching } from '../state/teaching';
import { useStudioDocument } from '../state/document';
import { clearRunningPlanPath } from './device-run';

/**
 * 3D 那一层打桩：真的 `mountVirtualDevice` 要建 WebGL 上下文，happy-dom 里起不来
 * （这是**测试环境**的限制，不是这一版的问题）。替身只要把面板订的那几条回一个「什么都不发生」
 * ——三张画布与它们的空态一个字都不受它影响。真身的契约有它自己的测试（`mount.test.ts`）。
 */
vi.mock('@codecanvas/robot3d', () => ({
	mountVirtualDevice: () => ({
		run: () => Promise.resolve({ ok: true, completed: 0, total: 0 }),
		beginStepRun: () => Promise.resolve({ ok: true, completed: 0, total: 0 }),
		releaseStep: () => undefined,
		onStepGate: () => () => undefined,
		reset: () => undefined,
		onStep: () => () => undefined,
		onPlanStep: () => () => undefined,
		dispose: () => undefined,
		size: { width: 0, height: 0 },
	}),
}));

const doc = useStudioDocument();
const teaching = useTeaching();

/** 动效偏好关掉：三条队列一次推满（这一组不看节奏）。 */
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

const wrappers: VueWrapper[] = [];

beforeEach(() => {
	stubReducedMotion();
	// 把那条真相通道清回「还没导入过任何东西」：模块级单例，不清就会带上一条用例的声明。
	doc.declaration.value = null;
	clearTeaching();
	clearRunningPlanPath();
});

afterEach(() => {
	for (const wrapper of wrappers.splice(0)) wrapper.unmount();
	vi.unstubAllGlobals();
});

describe('开局：什么都不灌', () => {
	it('声明是空的，而且**没有**偷偷发一次生成请求', () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		const wrapper = mount(App);
		wrappers.push(wrapper);

		expect(doc.declaration.value).toBeNull();
		expect(teaching.spec.value).toBeNull();
		// 没声明就什么都不发（材料都凑不齐，发出去只会得到一份编的）。
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('三张画布各自有话说（不是白屏，也不是一份推出来的旧链）', () => {
		const wrapper = mount(StudioShell);
		wrappers.push(wrapper);

		// 流程画布：说清它是什么、从哪来。
		expect(wrapper.get('[data-testid="flow-empty"]').text()).toContain('流程画布画的是一张真流程图');
		// 积木画布：说清「还没有积木可画」。
		expect(wrapper.get('[data-testid="blockly-empty"]').text()).toContain('还没有积木可画');
		// 代码面板：说清这一栏是什么。
		expect(wrapper.get('[data-testid="code-panel-empty"]').text()).toContain('还没有代码');
		// 画布上**没有**图、没有块、没有代码行——空态不是「画了一份空的」。
		expect(wrapper.find('[data-testid="flow-chart"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="code-panel-lines"]').exists()).toBe(false);
	});

	it('空态一个字都不提「示例」：屏幕上不该出现用户没说过的东西', () => {
		const wrapper = mount(StudioShell);
		wrappers.push(wrapper);
		expect(wrapper.text()).not.toContain('示例任务');
	});
});

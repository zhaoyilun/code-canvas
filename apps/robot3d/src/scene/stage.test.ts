// @vitest-environment happy-dom
/**
 * 拆舞台的验收：**一次 mount/dispose 必须把自己的 GPU 资源与 GL 上下文一起还回去**。
 *
 * 为什么这条值得单独钉：右栏切一次设备就真建一个 `WebGLRenderer`，浏览器对同时活着的
 * GL 上下文有硬上限（通常 ~16 个）。只 `dispose()` 不保证上下文被回收，切十几次就会开始丢上下文。
 * 所以这里断言的是 `renderer.dispose()` **与** `renderer.forceContextLoss()` 都被调到。
 *
 * 测得到什么：清理被调到、顺序对（先摘监听/放资源，最后丢上下文）、共享材质只放一次、
 * 挂在场景上的环境贴图不会漏。
 * 测不到什么（如实记）：真的 GL 上下文有没有被回收——happy-dom 没有 GL，这里用的是假渲染器；
 * 还有 `createStage` 内部的接线（它要真 `WebGLRenderer`，这里建不起来）——
 * 「取景量出来的机位真的把臂装得下」只能整条链在浏览器里验（见交付报告截图）。
 * 「反复 mount/dispose 不泄漏」同样只能在浏览器里验。
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { disposeStageResources, type RendererTeardown } from './stage';

type Spy = ReturnType<typeof vi.fn<() => void>>;

/** 假渲染器：只记「有没有被收」，不碰 GL */
function fakeRenderer(): { dispose: Spy; forceContextLoss: Spy } & RendererTeardown {
	return { dispose: vi.fn<() => void>(), forceContextLoss: vi.fn<() => void>() };
}

/** 监听某个 three 对象的 `dispose` 事件（three 的 dispose() 会派发它） */
function disposeSpy(target: THREE.BufferGeometry | THREE.Material | THREE.Texture): Spy {
	const spy = vi.fn<() => void>();
	target.addEventListener('dispose', spy);
	return spy;
}

describe('disposeStageResources', () => {
	it('渲染器与控制器都被收：dispose + forceContextLoss + controls.dispose', () => {
		const renderer = fakeRenderer();
		const controls = { dispose: vi.fn<() => void>() };
		const extra = { dispose: vi.fn<() => void>() };
		const scene = new THREE.Scene();

		disposeStageResources({ renderer, controls, root: scene, extras: [extra] });

		expect(renderer.dispose).toHaveBeenCalledTimes(1);
		expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
		expect(controls.dispose).toHaveBeenCalledTimes(1);
		expect(extra.dispose).toHaveBeenCalledTimes(1);
	});

	it('顺序：先摘监听、再放资源、最后丢上下文（反过来会往已释放的东西上写）', () => {
		const renderer = fakeRenderer();
		const controls = { dispose: vi.fn<() => void>() };
		const scene = new THREE.Scene();
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		scene.add(mesh);
		const materialDisposed = disposeSpy(mesh.material);

		disposeStageResources({ renderer, controls, root: scene });

		const order = (fn: Spy): number => fn.mock.invocationCallOrder[0] ?? -1;
		expect(order(controls.dispose)).toBeLessThan(order(renderer.dispose));
		expect(order(materialDisposed)).toBeLessThan(order(renderer.dispose));
		expect(order(renderer.dispose)).toBeLessThan(order(renderer.forceContextLoss));
	});

	it('整棵树都放：嵌套的几何与材质、共享材质只放一次、场景环境贴图不漏', () => {
		const renderer = fakeRenderer();
		const scene = new THREE.Scene();
		const shared = new THREE.MeshStandardMaterial();
		const geometry = new THREE.BoxGeometry(1, 1, 1);
		const nested = new THREE.Group();
		const a = new THREE.Mesh(geometry, shared);
		const b = new THREE.Mesh(geometry, shared); // 与 a 共用几何与材质
		const c = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial());
		nested.add(a, b);
		scene.add(nested, c);
		// 环境贴图挂在场景上而不是任何 mesh 的材质里：只走 traverse 会漏掉它
		const environment = new THREE.Texture();
		scene.environment = environment;

		const geometryDisposed = disposeSpy(geometry);
		const sharedDisposed = disposeSpy(shared);
		const sphereDisposed = disposeSpy(c.geometry);
		const separateMaterialDisposed = disposeSpy(c.material);
		const environmentDisposed = disposeSpy(environment);

		disposeStageResources({ renderer, controls: null, root: scene });

		expect(geometryDisposed).toHaveBeenCalledTimes(1);
		expect(sharedDisposed).toHaveBeenCalledTimes(1); // 两个 mesh 共用它，只放一次
		expect(sphereDisposed).toHaveBeenCalledTimes(1);
		expect(separateMaterialDisposed).toHaveBeenCalledTimes(1);
		expect(environmentDisposed).toHaveBeenCalledTimes(1);
	});
});

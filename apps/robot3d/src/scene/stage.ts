/**
 * 舞台：渲染器、灯光、工作台，以及每帧推进机械臂的循环。
 *
 * 尺度是米（臂高约 0.5 m），所以相机、阴影范围、地面都是真机量级——
 * 目录里的 workspace_limits 也是米，两边对得上，边界检查才有意义。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { So101Rig } from './so101';
import type { Kit } from './kit';

export interface Stage {
	readonly camera: THREE.PerspectiveCamera;
	render(dt: number): void;
	resize(): void;
	/** 拆舞台：停掉控制器、放掉这一场里的 GPU 资源、丢掉 GL 上下文。见 `disposeStageResources`。 */
	dispose(): void;
}

/**
 * 清理渲染器需要的最小面。真身是 `THREE.WebGLRenderer`；测试给假的——
 * happy-dom 里没有 GL 上下文，建不出真渲染器，但「清理有没有被调到」这件事必须能测。
 */
export interface RendererTeardown {
	dispose(): void;
	forceContextLoss(): void;
}

export interface StageDisposeInput {
	readonly renderer: RendererTeardown;
	/** 相机控制器（`OrbitControls`）：它自己挂的指针/滚轮监听由它的 `dispose()` 摘掉 */
	readonly controls?: { dispose(): void } | null;
	/** 要连根放掉的那棵树（这里是整个 scene，含机械臂） */
	readonly root: THREE.Object3D;
	/** 不在场景树上、但归这场所有的离屏资源（比如 PMREM 生成器） */
	readonly extras?: readonly { dispose(): void }[];
}

/** 走一棵树，把几何、材质、材质上挂的贴图收集起来（同一个对象只收一次） */
function collectTreeResources(root: THREE.Object3D): {
	geometries: Set<THREE.BufferGeometry>;
	materials: Set<THREE.Material>;
	textures: Set<THREE.Texture>;
} {
	const geometries = new Set<THREE.BufferGeometry>();
	const materials = new Set<THREE.Material>();
	const textures = new Set<THREE.Texture>();
	root.traverse((object) => {
		if (!(object instanceof THREE.Mesh)) return;
		geometries.add(object.geometry);
		const list = Array.isArray(object.material) ? object.material : [object.material];
		for (const material of list) {
			if (!(material instanceof THREE.Material)) continue;
			materials.add(material);
			for (const value of Object.values(material)) {
				if (value instanceof THREE.Texture) textures.add(value);
			}
		}
	});
	// 环境贴图挂在场景上，不在任何 mesh 的材质里——只走 traverse 会漏掉它
	if (root instanceof THREE.Scene && root.environment instanceof THREE.Texture) textures.add(root.environment);
	return { geometries, materials, textures };
}

/**
 * 拆一个舞台。**顺序是有讲究的**，反过来会出问题：
 *
 * 1. 先摘监听与控制器——不然清理过程中还会有人往已释放的东西上写；
 * 2. 再放这棵树上的几何/材质/贴图，以及 extras（PMREM 的 render target）；
 * 3. 最后 `renderer.dispose()` 放掉 three 自己持有的 GL 程序与缓冲，再
 *    `forceContextLoss()` 主动丢上下文。
 *
 * 为什么最后那一步不能省：这个应用**切一次设备就真建一个 `WebGLRenderer`**。
 * 浏览器对同时活着的 GL 上下文有硬上限（通常 ~16 个），只 `dispose()` 不保证
 * 上下文被回收——切十几次就会开始丢上下文甚至整页崩。实测 12 次没警告只是还没到线。
 */
export function disposeStageResources(input: StageDisposeInput): void {
	input.controls?.dispose();
	const { geometries, materials, textures } = collectTreeResources(input.root);
	for (const extra of input.extras ?? []) extra.dispose();
	for (const geometry of geometries) geometry.dispose();
	for (const texture of textures) texture.dispose();
	for (const material of materials) material.dispose();
	input.renderer.dispose();
	input.renderer.forceContextLoss();
}

export function createStage(canvas: HTMLCanvasElement, rig: So101Rig, kit: Kit): Stage {
	const { mat, box } = kit;
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x0a121d);
	scene.fog = new THREE.Fog(0x0a121d, 1.6, 4.2);

	const camera = new THREE.PerspectiveCamera(42, 1, 0.02, 40);
	camera.position.set(0.62, 0.48, 0.88);

	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.target.set(0, 0.16, 0.10);
	controls.minDistance = 0.18;
	controls.maxDistance = 1.6;
	controls.maxPolarAngle = Math.PI * 0.495;

	scene.add(new THREE.HemisphereLight(0x9dc0e0, 0x0a0f14, 0.5));
	const key = new THREE.DirectionalLight(0xfff3e2, 2.4);
	key.position.set(0.5, 0.9, 0.6);
	key.castShadow = true;
	key.shadow.mapSize.set(2048, 2048);
	key.shadow.camera.left = -0.6;
	key.shadow.camera.right = 0.6;
	key.shadow.camera.top = 0.6;
	key.shadow.camera.bottom = -0.6;
	key.shadow.camera.near = 0.1;
	key.shadow.camera.far = 3;
	key.shadow.bias = -0.0006;
	key.shadow.normalBias = 0.006;
	scene.add(key);
	const rim = new THREE.DirectionalLight(0x7fb0ff, 0.8);
	rim.position.set(-0.6, 0.4, -0.5);
	scene.add(rim);

	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
	scene.environmentIntensity = 0.4;

	// 工作台：台面 + 一块待抓的方块（手势有参照物才看得出在做什么）
	const table = box(1.4, 0.04, 1.0, 0.008, mat.wood);
	table.position.y = -0.02;
	table.receiveShadow = true;
	scene.add(table);

	const floor = new THREE.Mesh(
		new THREE.CylinderGeometry(6, 6, 0.4, 48),
		new THREE.MeshStandardMaterial({ color: 0x0d141c, roughness: 0.95, metalness: 0 }),
	);
	floor.position.y = -0.25;
	floor.receiveShadow = true;
	scene.add(floor);

	const block = box(0.03, 0.03, 0.03, 0.003, mat.block);
	block.position.set(0.12, 0.015, 0.16);
	scene.add(block);

	scene.add(rig.group);

	function resize(): void {
		const parent = canvas.parentElement;
		const w = parent?.clientWidth ?? 1;
		const h = parent?.clientHeight ?? 1;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}
	resize();

	return {
		camera,
		resize,
		render(dt: number) {
			rig.update(dt);
			controls.update();
			renderer.render(scene, camera);
		},
		dispose() {
			disposeStageResources({ renderer, controls, root: scene, extras: [pmrem] });
		},
	};
}

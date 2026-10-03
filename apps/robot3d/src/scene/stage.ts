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

/**
 * 待抓那方块摆在哪：**方块中心**，单位米，坐标系与 `workspace_limits` 同源
 * （`rig.group` 就在原点，所以方块的世界坐标就是基座系坐标）。
 *
 * 值的来历：`y = 0.015` 是方块高（0.03）的一半，于是它正好坐在台面（y = 0）上。
 * 这是**本机仿真的布景缺省**，不是任务参数——真机上目标物是相机看见的
 * （`pick_object` 的 `target_name` 是「红色方块」这种视觉查询，上游 `ibrobot_msgs`
 * 的 `PickObject.action` 里那是运行时文本查询），所以坐标一个字都不进声明与任务 JSON。
 */
export const DEFAULT_TARGET_BLOCK = { x: 0.12, y: 0.015, z: 0.16 } as const;

export interface Stage {
	readonly camera: THREE.PerspectiveCamera;
	render(dt: number): void;
	resize(): void;
	/** 把待抓的方块摆到 `position`（方块中心，单位米，基座系）。 */
	setTargetBlock(position: THREE.Vector3Like): void;
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

/**
 * 把方块摆到 `position`。**写的是本地坐标**，而这个 mesh 直接挂在场景上，所以本地就是世界坐标。
 *
 * 独立成函数是为了能测：`createStage` 要真 `WebGLRenderer`，happy-dom 里建不起来，
 * 但「入口真的把三个数写到那块 mesh 上了」这件事不该因此没人钉。
 */
export function placeTargetBlock(block: THREE.Object3D, position: THREE.Vector3Like): void {
	block.position.set(position.x, position.y, position.z);
	// 方块是动态摆放的：不刷一次矩阵，同一帧里读它世界位置的人（阴影、同一个帧里的后续计算）会拿到旧值
	block.updateMatrixWorld(true);
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

	const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 40);

	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	// 上下限跟着取景距离走（在下面量完包围盒才定）：写死的话，换个尺寸的臂就推不近也拉不远。
	controls.minDistance = 0.05;
	controls.maxDistance = 3;
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

	/*
	 * 待抓的方块：**引用要留出来**，它是这一场里唯一能被界面挪动的东西
	 * （`setTargetBlock` 改的就是它）。取景也含它一份（见下面 `framed`）。
	 */
	const block = box(0.03, 0.03, 0.03, 0.003, mat.block);
	scene.add(block);

	/** 把方块摆到 `position`。改的就是上面那块 mesh（见 `placeTargetBlock`）。 */
	function setTargetBlock(position: THREE.Vector3Like): void {
		placeTargetBlock(block, position);
	}
	// 缺省位置来自 `DEFAULT_TARGET_BLOCK` 这一份数：界面上的「复位」用的也是它，
	// 两处各写一遍数，早晚会有一处改漏（改漏了就是「复位之后方块不在缺省处」）。
	setTargetBlock(DEFAULT_TARGET_BLOCK);

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

	/**
	 * 机位**量出来**，不写死。
	 *
	 * 为什么：臂的尺寸与基座高度都是 `so101.ts` 里量出来的（`baseHeight` / `upperArm` /
	 * `foreArm` / `palmTop` / `finger`），写死一串坐标的话，那边改一个数，腕部就顶到画面外
	 * ——这一版之前正是这样（小窗里腕和夹爪被上沿切掉，台面却占了三分之二）。
	 * 所以：静止姿态量一次包围盒（**含待抓的那块方块**——它是这一步的参照物，切掉它
	 * 就看不出爪子够不够得着），把相机按包围球摆到看得全它的地方，再让出一成余量。
	 *
	 * 只量一次，之后画面完全交给鼠标（`OrbitControls`）——每帧重新取景会把用户拖出来的
	 * 视角顶回去。**挪方块也不重新取景**：那是同一件事的另一半，用户刚把视角拖到自己要看的
	 * 角度，界面里改一个数就把它顶回去，比构图不完美更坏。
	 */
	const framed = new THREE.Box3().setFromObject(rig.group).union(new THREE.Box3().setFromObject(block));
	const centre = framed.getCenter(new THREE.Vector3());
	const radius = framed.getSize(new THREE.Vector3()).length() * 0.5;
	const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
	const fitByHeight = radius / Math.tan((camera.fov * Math.PI) / 360);
	// 画布比高窄时，横向才是卡住取景的那一头——所以两个方向都算，取大的那个。
	const fitByWidth = fitByHeight / aspect;
	const distance = Math.max(fitByHeight, fitByWidth) * 1.04;
	// 一个偏左前上方的机位：看得到台面、也看得到爪子朝哪儿伸。
	const eye = new THREE.Vector3(0.46, 0.30, 1.0).normalize().multiplyScalar(distance);
	camera.position.copy(centre).add(eye);
	controls.target.copy(centre);
	controls.minDistance = distance * 0.25;
	controls.maxDistance = distance * 2.2;

	return {
		camera,
		resize,
		setTargetBlock,
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

/**
 * SO-101 单臂：实体 + 动作面（`ArmRigLike` 的实现）。
 *
 * **单位是米，量级按真机取**（见 `SO101_DIM`）——这样目录里 `workspace_limits`
 * 的边界检查才有意义；`three-models` 里那台 3 米高的演示臂在这儿不适用。
 * 连杆长度是 SO-101 量级的近似：真值在 `robot_description` 的 URDF 里，本次没导入，
 * 所以 `dimensionsSource` 如实标成 `approximate`，界面会显示出来。
 *
 * 关节映射（目录 1~5 → 本模型轴）：
 *   1 → J1 肩部回转    2 → J2 肩部抬升    3 → J3 肘部弯曲
 *   4 → J5 腕部俯仰    5 → J6 工具自转（夹爪绕自身轴）
 *   J4（前臂自转）SO-101 没有这一轴，恒为 0。
 * 符号表 `JOINT_SIGN` 是本模型的约定：它只影响画面上朝哪边转，不影响角度大小。
 */
import * as THREE from 'three';
import type { Kit } from './kit';
import type { ArmRigLike } from '../roboframe/executor';
import type { Waypoint } from '../roboframe/trajectory';

export const SO101_DIM = {
	baseHeight: 0.085, // 台面到肩关节轴
	baseRadius: 0.06,
	upperArm: 0.14, // 肩 → 肘
	foreArm: 0.16, // 肘 → 腕俯仰轴
	wristStack: 0.018, // 肘端 → 球腕中心（腕俯仰轴）
	flangeStack: 0.022, // 法兰面相对球腕中心的装饰性偏移（**不参与**运动学）
	palmTop: 0.062, // 球腕中心 → 手指根部
	finger: 0.055, // 手指长度
	fingerGapClosed: 0.022, // 闭爪时两指内表面间距的一半
	fingerGapOpen: 0.052,
	toolRadius: 0.03,
} as const;

/**
 * 运动学常数**从同一份布局推出来**——解析解的连杆长度必须和实际装出来的长度一致，
 * 否则解出来的位置系统性地差几厘米（之前差 0.04：肘到腕心还有两段堆叠没算）。
 */
const KIN = {
	shoulderY: SO101_DIM.baseHeight + 0.02, // j1(0.085) + j2(0.02)
	l1: SO101_DIM.upperArm,
	// 球腕：J4/J5/J6 三轴交于一点，所以「肘 → 腕心」只有一段，解算与装配才对得上
	l2: SO101_DIM.foreArm + SO101_DIM.wristStack,
	tool: SO101_DIM.palmTop + SO101_DIM.finger, // 腕心 → 指尖
} as const;

export const dimensionsSource = 'approximate' as const;
// 关节映射（目录 1~5）：1→J1、2→J2、3→J3、4→J5（腕俯仰）、5→J6（工具自转）；J4 恒 0
/** 每个关节的转向约定：目录给的是角度大小，朝哪边转由这里定 */
const JOINT_SIGN: Record<string, number> = { '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 };

/**
 * 显示零点偏移（弧度）——**不是上游真值**，是本模型的显示约定。
 *
 * 上游的关节零点在 SO-101 的标定里（`robot_description` 的 URDF 与标定文件），本次没导入，
 * 拿目录里的角度直接驱动本模型会摆出「举着手」这种读不懂的姿态。这三个偏移是为了让
 * 两个已知语义的姿态看着对：
 *   zero（全零）→ 上臂抬起、前臂前折的待命姿；
 *   observe_table（2=0.54, 3=-0.82, 4=-0.18）→ 末端前伸到台面上方约 0.2 m。
 * 界面上只影响**画出来的样子**；HUD 里显示的始终是目录原值，界面上也写着这句话。
 */
const DISPLAY_OFFSET = { j2: 0.36, j3: 1.42, j5: 1.46 } as const;

const EASE = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

type Motion =
	| { kind: 'joints'; from: number[]; to: number[]; t: number; dur: number; done: () => void }
	| { kind: 'waypoints'; list: readonly Waypoint[]; i: number; t: number; done: () => void }
	| { kind: 'gripper'; from: number; to: number; t: number; dur: number; done: () => void }
	| { kind: 'tool'; from: number; to: number; t: number; dur: number; done: () => void };

export class So101Rig implements ArmRigLike {
	/** 连杆长度与零点是估的（真值在 URDF 与标定文件里），所以边界只能提示不能否决 */
	readonly calibration = 'approximate' as const;

	readonly group = new THREE.Group();
	readonly dim = SO101_DIM;

	private readonly j1 = new THREE.Group();
	private readonly j2 = new THREE.Group();
	private readonly j3 = new THREE.Group();
	private readonly j4 = new THREE.Group();
	private readonly j5 = new THREE.Group();
	private readonly j6 = new THREE.Group();
	private readonly fingers: { mesh: THREE.Object3D; side: number }[] = [];

	/** 五个关节角（弧度），下标 0~4 对应目录关节 1~5 */
	private angles = [0, 0, 0, 0, 0];
	private toolRoll = 0;
	private aperture = 1;
	private motion: Motion | null = null;

	constructor(private readonly kit: Kit) {
		const { mat, box, cyl } = kit;
		const d = SO101_DIM;

		// 底座
		const base = cyl(d.baseRadius * 1.35, d.baseRadius * 1.6, 0.025, mat.graphite, 28);
		base.position.y = 0.0125;
		this.group.add(base);
		const column = cyl(d.baseRadius, d.baseRadius * 1.1, d.baseHeight - 0.025, mat.shell, 24);
		column.position.y = 0.025 + (d.baseHeight - 0.025) / 2;
		this.group.add(column);

		// J1 回转
		this.j1.position.y = d.baseHeight;
		this.group.add(this.j1);
		const yoke = box(d.baseRadius * 1.9, 0.03, d.baseRadius * 1.5, 0.008, mat.graphite);
		yoke.position.y = 0.015;
		this.j1.add(yoke);

		// J2 肩部抬升
		this.j2.position.y = 0.02;
		this.j1.add(this.j2);
		const shoulder = cyl(0.026, 0.026, 0.07, mat.darkSteel, 20);
		shoulder.rotation.z = Math.PI / 2;
		this.j2.add(shoulder);

		const upper = box(0.032, d.upperArm, 0.038, 0.012, mat.paint);
		upper.position.y = d.upperArm / 2;
		this.j2.add(upper);
		const upperRib = box(0.012, d.upperArm * 0.8, 0.042, 0.005, mat.graphite);
		upperRib.position.y = d.upperArm / 2;
		this.j2.add(upperRib);

		// J3 肘部
		this.j3.position.y = d.upperArm;
		this.j2.add(this.j3);
		const elbow = cyl(0.022, 0.022, 0.05, mat.darkSteel, 20);
		elbow.rotation.z = Math.PI / 2;
		this.j3.add(elbow);
		const elbowCap = cyl(0.024, 0.024, 0.006, mat.accent, 20);
		elbowCap.rotation.z = Math.PI / 2;
		elbowCap.position.x = 0.026;
		this.j3.add(elbowCap);

		const fore = box(0.026, d.foreArm, 0.03, 0.009, mat.shell);
		fore.position.y = d.foreArm / 2;
		this.j3.add(fore);
		const foreRib = box(0.009, d.foreArm * 0.75, 0.034, 0.004, mat.graphite);
		foreRib.position.y = d.foreArm / 2;
		this.j3.add(foreRib);

		// J4 前臂自转（SO-101 没有这一轴，恒 0，保留是为了球腕结构好摆）
		this.j4.position.y = d.foreArm;
		this.j3.add(this.j4);

		// J5 腕部俯仰
		this.j5.position.y = SO101_DIM.wristStack;
		this.j4.add(this.j5);
		const wristPitch = cyl(0.018, 0.018, 0.046, mat.darkSteel, 18);
		wristPitch.rotation.z = Math.PI / 2;
		this.j5.add(wristPitch);

		// J6 工具自转 + 夹爪
		// 球腕：J6 与 J5 同点（法兰面的那点偏移只做装饰，不进运动学，
		// 否则腕俯仰一转，指尖位置就会比解析解偏出 2cm）
		this.j6.position.y = 0;
		this.j5.add(this.j6);
		const flange = cyl(0.016, 0.019, 0.012, mat.steel, 20);
		flange.position.y = 0.006;
		this.j6.add(flange);
		const palm = box(0.034, 0.016, 0.026, 0.004, mat.graphite);
		palm.position.y = 0.022;
		this.j6.add(palm);
		const rail = box(0.076, 0.008, 0.018, 0.003, mat.graphite);
		rail.position.y = 0.032;
		this.j6.add(rail);

		for (const side of [-1, 1]) {
			const finger = box(0.008, d.finger, 0.02, 0.002, mat.steel);
			finger.position.y = d.palmTop + d.finger / 2;
			this.j6.add(finger);
			const pad = box(0.003, d.finger * 0.8, 0.016, 0.001, mat.rubber);
			pad.position.set(side * -0.003, finger.position.y, 0);
			finger.add(pad);
			this.fingers.push({ mesh: finger, side });
		}

		this.applyJoints();
		this.applyAperture();
	}

	// ---- 每帧推进 ---------------------------------------------------------

	update(dt: number): void {
		const m = this.motion;
		if (!m) return;
		m.t += dt;
		switch (m.kind) {
			case 'joints': {
				const k = EASE(Math.min(1, m.t / m.dur));
				this.angles = m.from.map((v, i) => v + ((m.to[i] ?? v) - v) * k);
				this.applyJoints();
				if (k >= 1) this.finish();
				break;
			}
			case 'waypoints': {
				const wp = m.list[m.i];
				if (!wp) {
					this.finish();
					break;
				}
				const k = Math.min(1, m.t / wp.dt);
				const target = this.waypointAngles(wp);
				const prev = m.i === 0 ? this.angles : this.waypointAngles(m.list[m.i - 1] ?? wp);
				this.angles = prev.map((v, idx) => v + ((target[idx] ?? v) - v) * EASE(k));
				this.applyJoints();
				if (k >= 1) {
					m.i += 1;
					m.t = 0;
					if (m.i >= m.list.length) this.finish();
				}
				break;
			}
			case 'gripper': {
				const k = EASE(Math.min(1, m.t / m.dur));
				this.aperture = m.from + (m.to - m.from) * k;
				this.applyAperture();
				if (k >= 1) this.finish();
				break;
			}
			case 'tool': {
				const k = EASE(Math.min(1, m.t / m.dur));
				this.toolRoll = m.from + (m.to - m.from) * k;
				this.applyJoints();
				if (k >= 1) this.finish();
				break;
			}
		}
	}

	private finish(): void {
		const done = this.motion?.done;
		this.motion = null;
		done?.();
	}

	private start(motion: Motion): Promise<void> {
		return new Promise((resolve) => {
			this.motion = { ...motion, done: resolve } as Motion;
		});
	}

	// ---- ArmRigLike -------------------------------------------------------

	moveJoints(joints: Record<string, number>, durationSec: number): Promise<void> {
		const to = [...this.angles];
		for (const [key, value] of Object.entries(joints)) {
			const index = Number(key) - 1;
			if (index < 0 || index > 4) continue;
			to[index] = (value ?? 0) * (JOINT_SIGN[key] ?? 1);
		}
		return this.start({ kind: 'joints', from: [...this.angles], to, t: 0, dur: Math.max(0.05, durationSec), done: () => {} });
	}

	playWaypoints(waypoints: readonly Waypoint[]): Promise<void> {
		if (waypoints.length === 0) return Promise.resolve();
		return this.start({ kind: 'waypoints', list: waypoints, i: 0, t: 0, done: () => {} });
	}

	setGripper(value01: number, durationSec: number): Promise<void> {
		return this.start({ kind: 'gripper', from: this.aperture, to: value01, t: 0, dur: Math.max(0.05, durationSec), done: () => {} });
	}

	/** 绕工具轴转：目录里 cw/ccw 给的是角度（度），ccw 为正 */
	rotateTool(degrees: number, durationSec: number): Promise<void> {
		const target = this.toolRoll + (degrees * Math.PI) / 180;
		return this.start({ kind: 'tool', from: this.toolRoll, to: target, t: 0, dur: Math.max(0.05, durationSec), done: () => {} });
	}

	/**
	 * 末端相对移动：方向解释见 README（up/down = +z/-z，left/right = ±y，forward/back = ±x，基座系）。
	 *
	 * 两个坑，都踩过：
	 * 1. 起点必须是**指尖**（`toolTip`），不是腕心——用腕心会凭空差一个 tool 的长度，一帧内跳过去；
	 * 2. 解出来的是目标姿态，**不能直接写进关节**——那样腕部会在第一帧弹到位。
	 *    所以解出目标关节角后，按关节插值走过去（关节空间的直线，不保证末端走直线，够用）。
	 */
	moveEE(direction: string, meters: number): Promise<void> {
		const map: Record<string, [number, number, number]> = {
			up: [0, 1, 0],
			down: [0, -1, 0],
			left: [0, 0, 1],
			right: [0, 0, -1],
			forward: [1, 0, 0],
			backward: [-1, 0, 0],
		};
		const axis = map[direction.toLowerCase()];
		if (!axis) return Promise.reject(new Error(`不认识的移动方向：${direction}`));
		const from = this.toolTip();
		const to = new THREE.Vector3(from.x + axis[0] * meters, from.y + axis[1] * meters, from.z + axis[2] * meters);
		const solved = this.solveAngles(to, this.toolDirection());
		if (!solved) return Promise.resolve();
		return this.start({ kind: 'joints', from: [...this.angles], to: solved, t: 0, dur: 0.6, done: () => {} });
	}

	poseJoints(): Record<string, number> {
		const out: Record<string, number> = {};
		this.angles.forEach((v, i) => {
			out[String(i + 1)] = v;
		});
		return out;
	}

	toolPosition(): { x: number; y: number; z: number } {
		const p = this.toolTip();
		// 转成上游 base 系口径：z 是高度
		return { x: p.x, y: p.z, z: p.y };
	}

	/**
	 * 正解：上游 workspace_limits 里那几个检查点。
	 * 坐标系同样按 base 系口径（z 向上）返回，与本模型的 y-up 做一次换轴。
	 */
	linkPositions(joints: Record<string, number>): Record<string, { x: number; y: number; z: number }> | null {
		const saved = [...this.angles];
		for (const [key, value] of Object.entries(joints)) {
			const index = Number(key) - 1;
			if (index >= 0 && index <= 4) this.angles[index] = value * (JOINT_SIGN[key] ?? 1);
		}
		this.applyJoints();
		this.group.updateMatrixWorld(true);
		const get = (obj: THREE.Object3D) => {
			const p = obj.getWorldPosition(new THREE.Vector3());
			return { x: p.x, y: p.z, z: p.y };
		};
		const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
		const p = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
		const shoulder = p(this.j2);
		const elbow = p(this.j3);
		const wrist = p(this.j5);
		const tip = this.toolTip();
		const base = (v: THREE.Vector3) => ({ x: v.x, y: v.z, z: v.y });
		const links = {
			joint3: base(elbow),
			upper_arm_mid: base(mid(shoulder, elbow)),
			forearm_mid: base(mid(elbow, wrist)),
			wrist_mid: base(wrist),
			ee: base(tip),
		};
		// 只做测量，量完把姿态还原
		this.angles = saved;
		this.applyJoints();
		return links;
	}

	reset(): void {
		this.motion = null;
		this.angles = [0, 0, 0, 0, 0];
		this.toolRoll = 0;
		this.aperture = 1;
		this.applyJoints();
		this.applyAperture();
	}

	// ---- 内部 -------------------------------------------------------------

	private waypointAngles(wp: Waypoint): number[] {
		const out = [...this.angles];
		for (const [key, value] of Object.entries(wp.joints)) {
			const index = Number(key) - 1;
			if (index >= 0 && index <= 4) out[index] = value * (JOINT_SIGN[key] ?? 1);
		}
		return out;
	}

	private applyJoints(): void {
		const [a1, a2, a3, a4, a5] = this.angles;
		const o = DISPLAY_OFFSET;
		this.j1.rotation.y = a1 ?? 0;
		this.j2.rotation.x = -((a2 ?? 0) + o.j2);
		this.j3.rotation.x = -((a3 ?? 0) + o.j3);
		this.j4.rotation.y = 0;
		this.j5.rotation.x = -((a4 ?? 0) + o.j5);
		this.j6.rotation.y = (a5 ?? 0) + this.toolRoll;
	}

	private applyAperture(): void {
		const { fingerGapClosed, fingerGapOpen } = SO101_DIM;
		const gap = fingerGapClosed + (fingerGapOpen - fingerGapClosed) * this.aperture;
		for (const f of this.fingers) f.mesh.position.x = f.side * (gap + 0.004);
	}

	/** 腕心（j6 原点）世界坐标 */
	private toolWorld(): THREE.Vector3 {
		this.group.updateMatrixWorld(true);
		return this.j6.getWorldPosition(new THREE.Vector3());
	}

	/** 指尖世界坐标 = 腕心 + 工具轴方向 × 工具长（工具轴是 j6 的局部 +Y） */
	private toolTip(): THREE.Vector3 {
		this.group.updateMatrixWorld(true);
		const tip = new THREE.Vector3(0, KIN.tool, 0);
		return this.j6.localToWorld(tip);
	}

	/** 工具轴当前的世界方向（单位向量） */
	private toolDirection(): THREE.Vector3 {
		this.group.updateMatrixWorld(true);
		const origin = this.j6.getWorldPosition(new THREE.Vector3());
		return this.toolTip().sub(origin).normalize();
	}

	/**
	 * 末端定位的解析解：给指尖目标与**工具朝哪儿**，返回五个关节角（纯函数，不改姿态）。
	 *
	 * 关键：手腕不重新定向——相对平移要保持工具当前姿态。
	 * 早先这里写死「工具朝下」，于是从 observe_table（腕部 -0.18）做一次相对移动，
	 * 会先把手腕拧 π-(-0.28) ≈ 3.6 rad 再走，看上去就是"闪现"。
	 *
	 * 算法：腕心 = 指尖 − tool · 工具方向；肩肘按平面双连杆解（双肘取上支）；
	 * 腕部俯仰 = 工具角 − (肩+肘)。
	 *
	 * **约定要对齐**（两处，都是踩过的坑）：
	 * 1. 算出的是「原始角」，渲染时 `applyJoints` 还要加 `DISPLAY_OFFSET`，返回前要减掉；
	 * 2. 模型里 j2 的正向旋转把手臂指向 **−z**（`R_x(−θ)` 把 +Y 送到 −z），而下面这套
	 *    平面推导的前向是 +z——两套镜像。所以先把目标搬到 (u,w) = (−x,−z) 再解，
	 *    否则解出来的 yaw 与当前差整整一个 π：底座会先原地转半圈再走，那就是"闪现"。
	 */
	private solveAngles(tipTarget: THREE.Vector3, toolDir: THREE.Vector3): number[] | null {
		const wrist = tipTarget.clone().addScaledVector(toolDir, -KIN.tool);
		// 搬到 (u, w) = (−x, −z)：模型里手臂的前向是 −z，平面推导的前向取 +w
		const yaw = Math.atan2(-wrist.x, -wrist.z);
		const sinY = Math.sin(yaw);
		const cosY = Math.cos(yaw);
		// 臂平面内的前向分量 r 与高度差 dy
		const r = -wrist.x * sinY - wrist.z * cosY;
		const dy = wrist.y - KIN.shoulderY;
		// 工具方向也投到同一平面
		const rComp = -toolDir.x * sinY - toolDir.z * cosY;
		const toolAngle = Math.atan2(rComp, toolDir.y);
		const dist = Math.min(Math.max(Math.hypot(r, dy), Math.abs(KIN.l1 - KIN.l2) + 1e-3), KIN.l1 + KIN.l2 - 1e-3);
		const cos3 = Math.min(1, Math.max(-1, (dist * dist - KIN.l1 ** 2 - KIN.l2 ** 2) / (2 * KIN.l1 * KIN.l2)));
		const phi = Math.atan2(r, dy);
		let best: { t2: number; t3: number; elbow: number } | null = null;
		for (const t3 of [Math.acos(cos3), -Math.acos(cos3)]) {
			const t2 = phi - Math.atan2(KIN.l2 * Math.sin(t3), KIN.l1 + KIN.l2 * Math.cos(t3));
			const elbow = KIN.l1 * Math.cos(t2);
			if (!best || elbow > best.elbow) best = { t2, t3, elbow };
		}
		if (!best) return null;
		// 腕部俯仰补齐到"工具角"——保持工具当前朝向，不强行掰成朝下
		const o = DISPLAY_OFFSET;
		const rawWrist = toolAngle - (best.t2 + best.t3);
		return [yaw, best.t2 - o.j2, best.t3 - o.j3, rawWrist - o.j5, this.angles[4] ?? 0];
	}
}

export { So101Rig as default };

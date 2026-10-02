import { describe, expect, it } from 'vitest';
import { createKit } from './kit';
import { So101Rig } from './so101';

/**
 * 这套测试钉的是"动起来像不像话"里最要紧的两条：
 * 不许一帧跳到位（闪现），以及相对移动真的按指定的方向走。
 */
const freshRig = (): So101Rig => new So101Rig(createKit());

const settle = (rig: So101Rig, seconds = 0.5): void => {
	for (let t = 0; t < seconds; t += 0.02) rig.update(0.02);
};

const maxJointDelta = (a: Record<string, number>, b: Record<string, number>): number =>
	Math.max(...Object.keys(a).map((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0))));

describe('So101Rig', () => {
	it('末端相对移动：第一帧不跳、全程每帧增量有界（这就是"闪现"的回归测试）', async () => {
		const rig = freshRig();
		void rig.moveJoints({ '1': 0.02, '2': 0.54, '3': -0.82, '4': -0.18, '5': 0.02 }, 0.3);
		settle(rig, 0.4);
		const before = rig.poseJoints();

		const done = rig.moveEE('up', 0.04);
		const deltas: number[] = [];
		let prev = { ...before };
		for (let i = 0; i < 60; i++) {
			rig.update(0.02);
			const now = rig.poseJoints();
			deltas.push(maxJointDelta(now, prev));
			prev = now;
		}
		await done;

		// 曾经这里是一个大跳：直接写角度（腕部瞬间弹到 π-(t2+t3)），起点还用了腕心
		expect(deltas[0]).toBeLessThan(0.02);
		expect(Math.max(...deltas)).toBeLessThan(0.2);
	});

	it('末端相对移动：往哪儿说要真往哪儿走（基座系，米）', async () => {
		const cases: [string, 'x' | 'y' | 'z', number][] = [
			['up', 'z', 1],
			['down', 'z', -1],
			['forward', 'x', 1],
			['left', 'y', 1],
			['right', 'y', -1],
		];
		for (const [direction, axis, sign] of cases) {
			// 每个方向都从同一个初始姿态出发单独试，别让上一条的结果影响下一条
			const rig = freshRig();
			void rig.moveJoints({ '1': 0.02, '2': 0.54, '3': -0.82, '4': -0.18, '5': 0.02 }, 0.3);
			settle(rig, 0.4);
			const from = rig.toolPosition();
			const done = rig.moveEE(direction, 0.03);
			settle(rig, 0.8);
			await done;
			const to = rig.toolPosition();
			const moved = (to[axis] - from[axis]) * sign;
			// 观察位姿已经接近满伸（余量只剩几厘米），横向再要 3cm 会被行程夹住——
			// 那是真实行为，执行器也会如实报"实际走了多远"。所以这里只查"方向对 + 走了一截"，
			// 精度不变量由上面那条 4cm 的测试独占把关。
			expect(moved, `${direction} 应该让 ${axis} 变化 ${String(sign)}`).toBeGreaterThan(0.012);
		}
	});

	it('不认识的方向直接拒绝，别静默不动', async () => {
		const rig = freshRig();
		await expect(rig.moveEE('sideways', 0.03)).rejects.toThrow(/方向/);
	});

	it('解析解要对得上装配：要 4cm 就真走 4cm（球腕同点 + 连杆长度取自同一份布局）', async () => {
		const rig = freshRig();
		void rig.moveJoints({ '1': 0.02, '2': 0.54, '3': -0.82, '4': -0.18, '5': 0.02 }, 0.3);
		settle(rig, 0.4);
		const before = rig.toolPosition();
		const request = 0.04;
		const done = rig.moveEE('up', request);
		settle(rig, 0.8);
		await done;
		const after = rig.toolPosition();
		// 曾经差 2cm：肘 → 腕心少算了一段、且那段还是转过腕俯仰之后的方向
		expect(after.z - before.z).toBeGreaterThan(request - 0.005);
		expect(after.z - before.z).toBeLessThan(request + 0.005);
	});

	it('相对移动不重新定向手腕：工具朝向基本不变', async () => {
		const rig = freshRig();
		void rig.moveJoints({ '1': 0.02, '2': 0.54, '3': -0.82, '4': -0.18, '5': 0.02 }, 0.3);
		settle(rig, 0.4);
		const wristBefore = rig.poseJoints()['4'] ?? 0;
		const done = rig.moveEE('up', 0.03);
		settle(rig, 0.8);
		await done;
		// 早先这里会被掰到 π-(t2+t3)≈3.4，差 3.6 rad
		expect(Math.abs((rig.poseJoints()['4'] ?? 0) - wristBefore)).toBeLessThan(0.6);
	});
});

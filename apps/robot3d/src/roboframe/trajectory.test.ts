import { describe, expect, it } from 'vitest';
import { asTemplate, checkLimits, synthesize, trajectorySeconds } from './trajectory';

/** 取目录里 wave_dance_v1 的真实形状（值照抄 dance_basic 的模板） */
const danceTemplate = {
	type: 'wave_dance_v1' as const,
	waypoint_duration_sec: 0.05,
	active_waypoint_count: 8,
	repeat_count: 2,
	zero_hold_count: 1,
	base_pose: { '1': 0.02, '2': 0.54, '3': -0.82, '4': -0.18, '5': 0.02 },
	joints: {
		'2': { terms: [{ amplitude: 0.3, harmonic: 1, phase: 0 }] },
		'3': { terms: [{ amplitude: 0.3, harmonic: 1, phase: 0 }] },
	},
};

const waveTemplate = {
	type: 'single_joint_wave_v1' as const,
	waypoint_duration_sec: 0.05,
	active_waypoint_count: 4,
	repeat_count: 1,
	base_pose: { '1': 0.02, '2': 0.54, '3': -0.82, '4': -0.18, '5': 0.02 },
	joint: '5',
	amplitude: 0.35,
};

describe('asTemplate', () => {
	it('认得出目录里的两种模板', () => {
		expect(asTemplate(danceTemplate)?.type).toBe('wave_dance_v1');
		expect(asTemplate(waveTemplate)?.type).toBe('single_joint_wave_v1');
	});

	it('认不出来就返回 null，不硬猜', () => {
		expect(asTemplate(null)).toBeNull();
		expect(asTemplate({ type: 'mystery_v9' })).toBeNull();
		expect(asTemplate({ type: 'wave_dance_v1', active_waypoint_count: 0 })).toBeNull();
	});
});

describe('synthesize', () => {
	it('单关节摆动：其余关节保持 base，摆动关节按正弦走且首拍为 base', () => {
		const wp = synthesize(waveTemplate);
		expect(wp).toHaveLength(4);
		expect(wp[0]?.joints['5']).toBeCloseTo(0.02, 10); // sin(0) = 0
		expect(wp[1]?.joints['5']).toBeCloseTo(0.02 + 0.35, 10); // sin(π/2) = 1
		expect(wp[2]?.joints['5']).toBeCloseTo(0.02, 10); // sin(π) = 0
		expect(wp[3]?.joints['5']).toBeCloseTo(0.02 - 0.35, 10); // sin(3π/2) = -1
		expect(wp[1]?.joints['2']).toBeCloseTo(0.54, 10);
	});

	it('多关节傅里叶：按 amplitude/harmonic/phase 叠加到 base 上', () => {
		const wp = synthesize(danceTemplate);
		// 8 拍 @0.05s × 重复 2 次 + 首尾各 1 拍归位
		expect(wp).toHaveLength(8 * 2 + 2);
		expect(trajectorySeconds(wp)).toBeCloseTo(18 * 0.05, 10);
		// zero_hold_count=1：首尾各一拍归位（这是本仓库的解释，见 trajectory.ts 注释）
		expect(wp[0]?.joints['2']).toBeCloseTo(0.54, 10);
		expect(wp[wp.length - 1]?.joints['2']).toBeCloseTo(0.54, 10);
		// 活动段从索引 1 开始：wp[1] 是 t=0，wp[2] 是 i=1（t=1/8，sin(2π/8)=sin(π/4)）
		expect(wp[1]?.joints['2']).toBeCloseTo(0.54, 10);
		expect(wp[2]?.joints['2']).toBeCloseTo(0.54 + 0.3 * Math.sin(Math.PI / 4), 10);
		expect(wp[2]?.joints['3']).toBeCloseTo(-0.82 + 0.3 * Math.sin(Math.PI / 4), 10);
		// i=4（t=0.5）时 sin(π)=0，回到 base
		expect(wp[5]?.joints['2']).toBeCloseTo(0.54, 10);
		// 重复段与首段一致
		expect(wp[10]?.joints['2']).toBeCloseTo(wp[2]?.joints['2'] ?? NaN, 10);
	});

	it('每拍时长照抄模板，不自己编', () => {
		const wp = synthesize({ ...waveTemplate, waypoint_duration_sec: 0.02 });
		expect(wp.every((w) => w.dt === 0.02)).toBe(true);
	});
});

describe('checkLimits', () => {
	const limits = { points: { ee: { z: [0.05, 0.55] as const } } };

	it('范围内返回 null', () => {
		expect(checkLimits(limits, 'ee', { z: 0.3 })).toBeNull();
	});

	it('越界给出可读原因', () => {
		expect(checkLimits(limits, 'ee', { z: 0.7 })).toContain('越界');
	});

	it('没有这项边界就不拦', () => {
		expect(checkLimits(undefined, 'ee', { z: 9 })).toBeNull();
		expect(checkLimits(limits, 'wrist_mid', { z: 9 })).toBeNull();
	});
});

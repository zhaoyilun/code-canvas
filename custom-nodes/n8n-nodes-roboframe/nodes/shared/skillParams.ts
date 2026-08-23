import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { toDataObject } from './bridge';

/** Shared skill invocation parameters (Robot Skill / Robot Validate). */
export const skillParams: INodeProperties[] = [
	{
		displayName: '技能名称或 ID',
		name: 'skill',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getSkillNames' },
		default: '',
		required: true,
		description: '从网关能力目录中选择要调用的高层机器人技能；可从列表选择，也可使用<a href="https://docs.n8n.io/code/expressions/">表达式</a>指定 ID。',
	},
	{
		displayName: '目标名称',
		name: 'targetName',
		type: 'string',
		displayOptions: { show: {} },
		default: '',
		description: '技能需要时填写课程内定义的语义目标对象标识',
	},
	{
		displayName: '位置名称',
		name: 'placeName',
		type: 'string',
		default: '',
		description: '技能需要时填写课程内定义的语义位置标识',
	},
	{
		displayName: '运动方向',
		name: 'motionDirection',
		type: 'options',
		options: [
			{ name: '前', value: 'forward' },
			{ name: '后', value: 'backward' },
			{ name: '左', value: 'left' },
			{ name: '右', value: 'right' },
			{ name: '上', value: 'up' },
			{ name: '下', value: 'down' },
		],
		default: 'forward',
		description: '技能需要时填写相对运动方向',
	},
	{
		displayName: '运动距离（米）',
		name: 'motionDistance',
		type: 'number',
		typeOptions: { numberPrecision: 3 },
		default: 0,
		description: '技能需要时填写相对运动距离，单位为米',
	},
	{
		displayName: '超时时间（秒）',
		name: 'timeoutSec',
		type: 'number',
		default: 0,
		description: '覆盖单个技能的超时时间；填写 0 时沿用技能超时策略',
	},
	{
		displayName: '附加参数 JSON',
		name: 'parametersJson',
		type: 'json',
		default: '{}',
		description: '按技能能力参数结构校验的附加参数',
	},
];

/** Assemble the request params sent to the bridge from node parameters. */
export function collectSkillParams(values: {
	targetName?: string | number;
	placeName?: string | number;
	motionDirection?: string | number;
	motionDistance?: string | number;
	timeoutSec?: string | number;
	parametersJson?: string | IDataObject;
}): { params: IDataObject; timeoutSec?: number } {
	const params: IDataObject = {};
	const target = trimParam(values.targetName);
	if (target !== null) params.target_name = target;
	const place = trimParam(values.placeName);
	if (place !== null) params.place_name = place;
	const direction = trimParam(values.motionDirection);
	if (direction !== null) params.motion_direction = direction;
	const distance = typeof values.motionDistance === 'number' ? values.motionDistance : undefined;
	if (distance !== undefined && Number.isFinite(distance) && distance > 0) {
		params.motion_distance = distance;
	}

	let extra: IDataObject = {};
	if (typeof values.parametersJson === 'string' && values.parametersJson.trim() !== '') {
		const parsed: unknown = JSON.parse(values.parametersJson);
		const converted = toDataObject(parsed);
		if (converted === null) throw new Error('parameters JSON must be an object');
		extra = converted;
	} else if (values.parametersJson !== undefined) {
		const converted = toDataObject(values.parametersJson);
		if (converted === null) throw new Error('parameters JSON must be an object');
		extra = converted;
	}
	const merged: IDataObject = { ...extra, ...params };
	return { params: merged, timeoutSec: timeoutOf(values.timeoutSec) };
}

function timeoutOf(value: string | number | undefined): number | undefined {
	const numeric = typeof value === 'number' ? value : undefined;
	if (numeric === undefined || !Number.isFinite(numeric) || numeric <= 0) return undefined;
	return numeric;
}

function trimParam(value: string | number | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

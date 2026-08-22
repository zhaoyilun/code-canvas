import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { toDataObject } from './bridge';

/** Shared skill invocation parameters (Robot Skill / Robot Validate). */
export const skillParams: INodeProperties[] = [
	{
		displayName: 'Skill Name or ID',
		name: 'skill',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getSkillNames' },
		default: '',
		required: true,
		description: 'High-level robot skill to invoke, from the bridge catalog. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Target Name',
		name: 'targetName',
		type: 'string',
		displayOptions: { show: {} },
		default: '',
		description: 'Semantic target object name (e.g. demo_object), when the skill requires it',
	},
	{
		displayName: 'Place Name',
		name: 'placeName',
		type: 'string',
		default: '',
		description: 'Semantic place name (e.g. home), when the skill requires it',
	},
	{
		displayName: 'Motion Direction',
		name: 'motionDirection',
		type: 'options',
		options: [
			{ name: 'Backward', value: 'backward' },
			{ name: 'Down', value: 'down' },
			{ name: 'Forward', value: 'forward' },
			{ name: 'Left', value: 'left' },
			{ name: 'Right', value: 'right' },
			{ name: 'Up', value: 'up' },
		],
		default: 'forward',
		description: 'Relative motion direction, when the skill requires it',
	},
	{
		displayName: 'Motion Distance (M)',
		name: 'motionDistance',
		type: 'number',
		typeOptions: { numberPrecision: 3 },
		default: 0,
		description: 'Relative motion distance in meters, when the skill requires it',
	},
	{
		displayName: 'Timeout (S)',
		name: 'timeoutSec',
		type: 'number',
		default: 0,
		description: 'Per-skill timeout override; 0 keeps the skill timeout policy',
	},
	{
		displayName: 'Extra Parameters JSON',
		name: 'parametersJson',
		type: 'json',
		default: '{}',
		description: 'Additional parameters validated against the skill capability schema',
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

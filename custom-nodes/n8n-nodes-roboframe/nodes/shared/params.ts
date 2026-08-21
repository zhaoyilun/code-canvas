import type { IExecuteFunctions, IDataObject  } from 'n8n-workflow';

/** Typed accessors over getNodeParameter using runtime guards instead of casts. */

export function stringParam(
	context: IExecuteFunctions,
	name: string,
	index: number,
	fallback: string,
): string {
	const value = context.getNodeParameter(name, index, fallback);
	return typeof value === 'string' ? value : fallback;
}

export function numberParam(
	context: IExecuteFunctions,
	name: string,
	index: number,
	fallback: number,
): number {
	const value = context.getNodeParameter(name, index, fallback);
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function booleanParam(
	context: IExecuteFunctions,
	name: string,
	index: number,
	fallback: boolean,
): boolean {
	const value = context.getNodeParameter(name, index, fallback);
	return typeof value === 'boolean' ? value : fallback;
}

export function jsonParam(
	context: IExecuteFunctions,
	name: string,
	index: number,
): string | IDataObject {
	const fallback = '{}';
	const value = context.getNodeParameter(name, index, fallback);
	if (typeof value === 'string') return value;
	if (isDataObject(value)) return value;
	return fallback;
}

function isDataObject(value: unknown): value is IDataObject {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	for (const entry of Object.values(value)) {
		if (entry === null) continue;
		if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
			continue;
		}
		if (!isDataObject(entry)) return false;
	}
	return true;
}

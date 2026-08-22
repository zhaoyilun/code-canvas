/** HTTP client for the RoboFrame bridge, with an injectable transport so node
 * logic stays unit-testable without a live robot. */

import type { IDataObject } from 'n8n-workflow';

export type BridgeResponse = { status: number; body: unknown };

export type Transport = (
	method: string,
	path: string,
	body?: unknown,
) => Promise<BridgeResponse & { terminalHeader?: boolean }>;

export type BridgeClientOptions = {
	baseUrl: string;
	token?: string;
	transport: Transport;
};

export type ActionKind = 'skill' | 'primitive';

export type RobotAction = {
	kind: ActionKind;
	name: string;
};

export type TaskLookup = { body: IDataObject; terminal: boolean } | null;

/** Transport/boundary failure; wrapError maps it to NodeOperationError. */
export class BridgeError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export function bridgeError(message: string, status: number): BridgeError {
	return new BridgeError(message, status);
}

export class BridgeClient {
	private readonly baseUrl: string;

	private readonly transport: Transport;

	constructor(options: BridgeClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.transport = options.transport;
	}

	async catalog(): Promise<IDataObject> {
		return this.getJson('/v1/catalog');
	}

	async skillNames(): Promise<string[]> {
		const catalog = await this.catalog();
		return extractSkillNames(catalog);
	}

	async poses(): Promise<string[]> {
		const body = await this.poseCatalog();
		return Array.isArray(body.poses) ? body.poses.map(String) : [];
	}

	async poseCatalog(): Promise<IDataObject> {
		return this.getJson('/v1/catalog/poses');
	}

	async status(): Promise<IDataObject> {
		return this.getJson('/v1/status');
	}

	async validate(action: RobotAction, params: IDataObject): Promise<IDataObject> {
		return this.postJson('/v1/actions/validate', { action, params });
	}

	async execute(
		taskId: string,
		action: RobotAction,
		params: IDataObject,
		timeoutSec?: number,
		context?: IDataObject,
	): Promise<IDataObject> {
		return this.postJson('/v1/actions/execute', {
			task_id: taskId,
			action,
			params,
			...(timeoutSec === undefined ? {} : { timeout_sec: timeoutSec }),
			...(context === undefined ? {} : { context }),
		});
	}

	async task(taskId: string): Promise<TaskLookup> {
		const response = await this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
		if (response.status === 404) {
			return null;
		}
		const body = toDataObject(response.body);
		if (response.status !== 200 || body === null) {
			throw bridgeError(
				errorText(body) ?? `task query failed (${response.status})`,
				response.status,
			);
		}
		const state = typeof body.state === 'string' ? body.state : '';
		return { body, terminal: response.terminalHeader === true || TERMINAL_STATES.has(state) };
	}

	async cancel(taskId: string): Promise<IDataObject> {
		return this.postJson(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {});
	}

	private async getJson(path: string): Promise<IDataObject> {
		return this.expectOk(await this.request('GET', path));
	}

	private async postJson(path: string, body: unknown): Promise<IDataObject> {
		return this.expectOk(await this.request('POST', path, body));
	}

	private expectOk(response: BridgeResponse & { terminalHeader?: boolean }): IDataObject {
		if (response.status >= 200 && response.status < 300) {
			const body = toDataObject(response.body);
			if (body !== null) return body;
		}
		const body = toDataObject(response.body);
		throw bridgeError(errorText(body) ?? `bridge error (${response.status})`, response.status);
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<BridgeResponse & { terminalHeader?: boolean }> {
		try {
			return await this.transport(method, `${this.baseUrl}${path}`, body);
		} catch (error) {
			throw bridgeError(
				error instanceof Error ? `bridge unreachable: ${error.message}` : 'bridge unreachable',
				0,
			);
		}
	}
}

export const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'unknown']);

export function buildFetchTransport(token: string | undefined): Transport {
	return async (method, url, body) => {
		const response = await fetch(url, {
			method,
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		let parsed: unknown = null;
		const text = await response.text();
		if (text !== '') {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = { detail: text };
			}
		}
		return {
			status: response.status,
			body: parsed,
			terminalHeader: response.headers.get('X-Terminal-State') === 'True',
		};
	};
}

export function extractSkillNames(catalog: IDataObject): string[] {
	const skills = catalog.skills;
	if (!Array.isArray(skills)) return [];
	return skills
		.map((skill) => toDataObject(skill))
		.filter((skill): skill is IDataObject => skill !== null)
		.map((skill) => (typeof skill.name === 'string' ? skill.name : ''))
		.filter((name) => name !== '');
}

/** Runtime type guard converting parsed JSON objects to IDataObject without casts. */
export function toDataObject(value: unknown): IDataObject | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record: IDataObject = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isDataObjectValue(entry)) {
			record[key] = entry;
		} else {
			return null;
		}
	}
	return record;
}

function isDataObjectValue(value: unknown): value is IDataObject[string] {
	if (value === null) return true;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return true;
	}
	if (Array.isArray(value)) return value.every((entry) => isDataObjectValue(entry));
	if (typeof value === 'object') return toDataObject(value) !== null;
	return false;
}

function errorText(body: IDataObject | null): string | null {
	if (body === null) return null;
	if (typeof body.detail === 'string') return body.detail;
	if (typeof body.message === 'string') return body.message;
	return null;
}

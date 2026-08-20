export const BLOCKLY_SCHEMA_VERSION = 1;

export type BlocklyWorkspaceState = Record<string, unknown>;

export type BlocklyEditorPayload = {
	schemaVersion: typeof BLOCKLY_SCHEMA_VERSION;
	workspace: BlocklyWorkspaceState;
	javascript: string;
};

export function parseBlocklyEditorPayload(value: string): BlocklyEditorPayload | null {
	if (!value.trim()) return null;

	try {
		const parsed: unknown = JSON.parse(value);

		if (!isBlocklyEditorPayload(parsed)) return null;

		return parsed;
	} catch {
		return null;
	}
}

export function createDefaultWorkspace(): BlocklyWorkspaceState {
	return {
		blocks: {
			languageVersion: 0,
			blocks: [
				{
					type: 'n8n_return_output',
					x: 24,
					y: 24,
					inputs: {
						VALUE: {
							block: {
								type: 'math_number',
								fields: { NUM: 42 },
							},
						},
					},
				},
			],
		},
	};
}

export function serializeBlocklyEditorPayload(
	workspace: BlocklyWorkspaceState,
	javascript: string,
): string {
	return JSON.stringify({
		schemaVersion: BLOCKLY_SCHEMA_VERSION,
		workspace,
		javascript: javascript.trim(),
	});
}

function isBlocklyEditorPayload(value: unknown): value is BlocklyEditorPayload {
	if (!isRecord(value)) return false;

	return (
		value.schemaVersion === BLOCKLY_SCHEMA_VERSION &&
		isRecord(value.workspace) &&
		typeof value.javascript === 'string'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

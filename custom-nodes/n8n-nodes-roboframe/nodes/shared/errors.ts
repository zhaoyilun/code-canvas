import type { INode } from 'n8n-workflow';
import { NodeOperationError as NodeError } from 'n8n-workflow';
import { BridgeError } from './bridge';

export type NodeLike = { getNode(): INode };

/** Map bridge/transport failures to concise NodeOperationError messages.
 * Auth and parameter problems stay user-actionable; transport problems keep
 * the operational detail for the error branch. */
export function wrapError(context: NodeLike, error: unknown): NodeError {
	if (error instanceof NodeError) return error;
	if (error instanceof BridgeError) {
		const detail = error.status === 401 ? 'bridge rejected the token' : error.message;
		return new NodeError(context.getNode(), `RoboFrame bridge error: ${detail}`);
	}
	const message = error instanceof Error ? error.message : 'unknown error';
	return new NodeError(context.getNode(), message);
}

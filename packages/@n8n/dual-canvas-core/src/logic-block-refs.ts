import { stableReferenceSchema } from './primitives';
import { createStableId } from './stable-ids';

export function createLogicStatementBlockRef(
	documentRef: string,
	nodeRef: string,
	stepRef: string,
): string {
	stableReferenceSchema.parse(nodeRef);
	stableReferenceSchema.parse(stepRef);
	return `logic-${createStableId(documentRef, `${nodeRef}:statement:${stepRef}`)}`;
}

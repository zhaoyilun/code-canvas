import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

import { stableReferenceSchema } from './primitives';

const DUAL_CANVAS_ID_NAMESPACE = '06638dff-2c26-4aab-a7f7-1219a5014b06';
const localIdentitySchema = z.string().min(1).max(4096);

export function createStableId(scopeRef: string, localRef: string): string {
	stableReferenceSchema.parse(scopeRef);
	localIdentitySchema.parse(localRef);
	return uuidV5(`${scopeRef}:${localRef}`, DUAL_CANVAS_ID_NAMESPACE);
}

export function createStableArtifactRef(
	kind: 'node' | 'edge' | 'canvas' | 'block' | 'step' | 'mapping' | 'event',
	scopeRef: string,
	localRef: string,
): string {
	return `${kind}-${createStableId(scopeRef, `${kind}:${localRef}`)}`;
}

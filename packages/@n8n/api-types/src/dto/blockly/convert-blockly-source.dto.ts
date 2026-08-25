import type { WorkflowFragmentV1 } from '@n8n/dual-canvas-core';
import { z } from 'zod';

import { Z } from '../../zod-class';

export class ConvertBlocklySourceRequestDto extends Z.class({
	source: z.string().min(1),
	currentBlocklyPayload: z.string(),
	generateMissingOperation: z.boolean(),
	teacherIntent: z.string().trim().min(1).optional(),
}) {}

export type BlocklySourceReadyResponse = {
	status: 'ready';
	blocklyPayload: string;
	workflowFragment: WorkflowFragmentV1;
};

export type BlocklySourceMissingOperationResponse = {
	status: 'missing-operation';
	qualifiedName: string;
	arity: number;
	message: string;
};

export type ConvertBlocklySourceResponse =
	| BlocklySourceReadyResponse
	| BlocklySourceMissingOperationResponse;

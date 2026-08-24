export {
	BLOCKLY_DATA_SCHEMA_VERSION,
	compileBlocklyWorkspace,
	createDefaultWorkspace,
	parseBlocklyDataPayload,
	serializeBlocklyDataPayload,
} from '@n8n/blockly-data-transform';

export type { BlocklyDataPayload, CompileResult } from '@n8n/blockly-data-transform';
export {
	createOperationBlockDescriptorV1,
	createOperationModuleCatalogV1,
	finalizeOperationModuleSpecV1,
} from '@n8n/dual-canvas-operation-runtime';
export type {
	OperationModuleCatalogV1,
	OperationModuleSpecV1,
} from '@n8n/dual-canvas-operation-runtime';

import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { clientFromCredentials } from '../shared/context';
import { wrapError } from '../shared/errors';

export class RobotStatus implements INodeType {
	description: INodeTypeDescription = {
		displayName: '机器人状态',
		name: 'robotStatus',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['input'],
		version: 1,
		description: '查询 RoboFrame 技能网关的当前状态',
		subtitle: '读取技能网关状态',
		defaults: { name: '机器人状态' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'robframeBridgeApi', required: true }],
		properties: [],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData(0);
		try {
			const client = await clientFromCredentials(this);
			const status = await client.status();
			const normalized = robotStatusJson(status);
			const output: INodeExecutionData[] = [];
			for (let index = 0; index < items.length; index++) {
				output.push({
					json: { ...items[index].json, ...normalized },
					pairedItem: { item: index },
				});
			}
			if (output.length === 0) {
				output.push({ json: normalized, pairedItem: { item: 0 } });
			}
			return [output];
		} catch (error) {
			throw wrapError(this, error);
		}
	}
}

/** Keep the n8n node output aligned with RoboFrame's public status payload. */
export function robotStatusJson(status: IDataObject): IDataObject {
	return {
		schemaVersion: numberValue(status.schema_version),
		robotName: stringValue(status.robot_name),
		motionAuthorized: status.motion_authorized === true,
		activeControlMode: stringValue(status.active_control_mode),
		busy: status.busy === true,
		activeTaskId: stringValue(status.active_task_id),
		defaultSkillTimeoutSec: numberValue(status.default_skill_timeout_sec),
		taskBudgetSec: numberValue(status.task_budget_sec),
		rpcTimeoutSec: numberValue(status.rpc_timeout_sec),
		configDigest: stringValue(status.config_digest),
		capabilityDigest: stringValue(status.capability_digest),
		registryEpoch: stringValue(status.registry_epoch),
		registryGeneration: numberValue(status.registry_generation),
		registryDigest: stringValue(status.registry_digest),
		primitiveContractDigest: stringValue(status.primitive_contract_digest),
		sourceReleaseDigest: stringValue(status.source_release_digest),
		provenanceDigest: stringValue(status.provenance_digest),
		controlPlaneReady: status.control_plane_ready === true,
		controlPlaneState: stringValue(status.control_plane_state),
		controlPlaneErrorCode: stringValue(status.control_plane_error_code),
		requestState: stringValue(status.request_state),
		requestErrorCode: stringValue(status.request_error_code),
		capabilities: Array.isArray(status.capabilities) ? status.capabilities : [],
	};
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

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
		displayName: 'Robot Status',
		name: 'robotStatus',
		icon: { light: 'file:roboframe.svg', dark: 'file:roboframe.dark.svg' },
		group: ['input'],
		version: 1,
		description: 'Query the RoboFrame skill gateway status',
		subtitle: 'Queries the skill gateway status',
		defaults: { name: 'Robot Status' },
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
			const output: INodeExecutionData[] = [];
			for (let index = 0; index < items.length; index++) {
				const json: IDataObject = {
					motionAuthorized: status.motion_authorized === true,
					activeControlMode: status.active_control_mode ?? '',
					requiredControlMode: status.required_control_mode ?? '',
					busy: status.busy === true,
					activeTaskId: status.active_task_id ?? '',
					readiness: status.readiness ?? {},
				};
				output.push({ json, pairedItem: { item: index } });
			}
			if (output.length === 0) {
				output.push({
					json: {
						motionAuthorized: status.motion_authorized === true,
						busy: status.busy === true,
					},
					pairedItem: { item: 0 },
				});
			}
			return [output];
		} catch (error) {
			throw wrapError(this, error);
		}
	}
}

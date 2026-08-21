import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class RoboFrameBridgeApi implements ICredentialType {
	name = 'robframeBridgeApi';

	displayName = 'RoboFrame Bridge API';

	documentationUrl = 'https://gitcode.com/openeuler/IB_Robot';

	icon = 'file:roboframe.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'http://robot-host:8090',
			required: true,
		},
		{
			displayName: 'Bearer Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'RoboFrame bridge token (ROBOFRAME_BRIDGE_TOKEN on the robot side)',
		},
	];

	test = async (credentials: Record<string, unknown>): Promise<{ status: 'OK' | 'Error'; message: string }> => {
		const baseUrl = typeof credentials.baseUrl === 'string' ? credentials.baseUrl.replace(/\/+$/, '') : '';
		if (baseUrl === '') {
			return { status: 'Error', message: 'Base URL is required' };
		}
		const token = typeof credentials.token === 'string' && credentials.token !== '' ? credentials.token : undefined;
		try {
			const response = await fetch(`${baseUrl}/v1/health`, {
				headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
			});
			if (response.ok) return { status: 'OK', message: 'Connection OK' };
			return { status: 'Error', message: `Bridge responded with ${response.status}` };
		} catch (error) {
			return {
				status: 'Error',
				message: error instanceof Error ? error.message : 'Bridge unreachable',
			};
		}
	};
}

import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class RoboFrameBridgeApi implements ICredentialType {
	name = 'robframeBridgeApi';

	displayName = 'RoboFrame Bridge API';

	documentationUrl = 'https://gitcode.com/openeuler/IB_Robot';

	icon = { light: 'file:roboframe.svg', dark: 'file:roboframe.svg' } as const;

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

	// Declarative test (ICredentialTestRequest): the credential test button
	// issues an authenticated status request so both endpoint and token are checked.
	test: ICredentialType['test'] = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/v1/status',
			headers: {
				Authorization: '={{$credentials.token ? `Bearer ${$credentials.token}` : ""}}',
			},
		},
		rules: [
			{
				type: 'responseCode',
				properties: { value: 200, message: 'Bridge authorization check failed' },
			},
		],
	};
}

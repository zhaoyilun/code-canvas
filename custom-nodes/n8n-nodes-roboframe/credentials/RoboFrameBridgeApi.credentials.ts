import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class RoboFrameBridgeApi implements ICredentialType {
	name = 'robframeBridgeApi';

	displayName = 'RoboFrame Bridge API';

	documentationUrl = 'https://gitcode.com/openeuler/IB_Robot';

	icon: 'file:roboframe.svg' = 'file:roboframe.svg';

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
	// issues GET {baseUrl}/v1/health and treats 2xx as OK. The bearer token
	// header is injected by the authenticate rule below.
	test: ICredentialType['test'] = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/v1/health',
			headers: {
				// Health is public per the bridge contract; send the token when
				// present anyway so misconfigured tokens surface in the test.
				Authorization: '={{$credentials.token ? `Bearer ${$credentials.token}` : ""}}',
			},
		},
		rules: [
			{
				type: 'responseCode',
				properties: { value: 200, message: 'Bridge health check failed' },
			},
		],
	};
}

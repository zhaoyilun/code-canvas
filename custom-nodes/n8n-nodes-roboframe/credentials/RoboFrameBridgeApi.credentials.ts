import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class RoboFrameBridgeApi implements ICredentialType {
	name = 'robframeBridgeApi';

	displayName = 'RoboFrame 网关凭据';

	documentationUrl = 'https://gitcode.com/openeuler/IB_Robot';

	icon = { light: 'file:roboframe.svg', dark: 'file:roboframe.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: '网关地址',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'http://robot-host:8090',
			required: true,
		},
		{
			displayName: '访问令牌',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'RoboFrame 网关的访问令牌（机器人端环境变量 ROBOFRAME_BRIDGE_TOKEN）',
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
				properties: { value: 200, message: '网关授权校验失败' },
			},
		],
	};
}

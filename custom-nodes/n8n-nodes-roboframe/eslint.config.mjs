import { config } from '@n8n/node-cli/eslint';

export default [
	...config,
	{
		rules: {
			'@n8n/community-nodes/valid-author': 'off',
			'@n8n/community-nodes/node-usable-as-tool': 'off',
		},
	},
];

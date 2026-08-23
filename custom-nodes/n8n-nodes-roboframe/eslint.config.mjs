import { config } from '@n8n/node-cli/eslint';

export default [
	...config,
	{
		rules: {
			'@n8n/community-nodes/valid-author': 'off',
			'@n8n/community-nodes/node-usable-as-tool': 'off',
			// 教学工作台面向中文界面；以下规则仅验证英文写法，不能用于本包的本地化元数据。
			'n8n-nodes-base/cred-class-field-display-name-missing-api': 'off',
			'n8n-nodes-base/node-param-description-boolean-without-whether': 'off',
			'n8n-nodes-base/node-param-description-wrong-for-dynamic-options': 'off',
			'n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options': 'off',
			'n8n-nodes-base/node-param-options-type-unsorted-items': 'off',
		},
	},
];

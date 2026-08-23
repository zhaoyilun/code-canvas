import { describe, expect, it } from 'vitest';

import { RoboFrameBridgeApi } from '../../credentials/RoboFrameBridgeApi.credentials';

describe('RoboFrame Bridge credential test', () => {
	it('checks the protected status endpoint with the bearer credential', () => {
		const credential = new RoboFrameBridgeApi();
		expect(credential.displayName).toBe('RoboFrame 网关凭据');
		expect(credential.properties.map((property) => property.displayName)).toEqual([
			'网关地址',
			'访问令牌',
		]);
		expect(credential.test?.request).toMatchObject({
			url: '/v1/status',
			headers: {
				Authorization: expect.stringContaining('Bearer'),
			},
		});
		expect(credential.test?.rules).toContainEqual({
			type: 'responseCode',
			properties: { value: 200, message: '网关授权校验失败' },
		});
	});
});

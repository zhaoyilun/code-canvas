import { describe, expect, it } from 'vitest';

import { RoboFrameBridgeApi } from '../../credentials/RoboFrameBridgeApi.credentials';

describe('RoboFrame Bridge credential test', () => {
	it('checks the protected status endpoint with the bearer credential', () => {
		const credential = new RoboFrameBridgeApi();
		expect(credential.test?.request).toMatchObject({
			url: '/v1/status',
			headers: {
				Authorization: expect.stringContaining('Bearer'),
			},
		});
		expect(credential.test?.rules).toContainEqual({
			type: 'responseCode',
			properties: { value: 200, message: 'Bridge authorization check failed' },
		});
	});
});

import { BridgeClient, buildFetchTransport } from './bridge';

const CREDENTIAL_NAME = 'robframeBridgeApi';

/** Minimal credential-reading seam so both IExecuteFunctions and
 * ILoadOptionsFunctions satisfy it without casts. */
export type CredentialContext = {
	getCredentials(name: string): Promise<unknown>;
};

export async function clientFromCredentials(context: CredentialContext): Promise<BridgeClient> {
	const credentials = await context.getCredentials(CREDENTIAL_NAME);
	const baseUrl = credentialString(credentials, 'baseUrl').trim();
	if (baseUrl === '') {
		throw new Error('RoboFrame Bridge credential is missing its Base URL');
	}
	const tokenValue = credentialString(credentials, 'token');
	const token = tokenValue === '' ? undefined : tokenValue;
	return new BridgeClient({ baseUrl, token, transport: buildFetchTransport(token) });
}

function credentialString(credentials: unknown, field: string): string {
	if (typeof credentials !== 'object' || credentials === null) return '';
	for (const [key, value] of Object.entries(credentials)) {
		if (key === field && typeof value === 'string') return value;
	}
	return '';
}

export { CREDENTIAL_NAME };

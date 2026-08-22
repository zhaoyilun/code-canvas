import type { IDataObject } from 'n8n-workflow';
import type { RobotTaskPlan } from '@n8n/blockly-robot-skills';
import type { ActionClient } from './engine';

export type CatalogDigestCheck = {
	valid: boolean;
	plan: string;
	live: string;
	message: string;
};

/** Compare the digest compiled into the plan with the live execution catalog. */
export async function checkCatalogDigest(
	client: ActionClient,
	plan: RobotTaskPlan,
): Promise<CatalogDigestCheck> {
	const catalog = await client.catalog();
	const live = typeof catalog.config_digest === 'string' ? catalog.config_digest : '';
	if (plan.configDigest === '') {
		return {
			valid: false,
			plan: '',
			live,
			message: 'plan configDigest is required',
		};
	}
	if (live === '') {
		return {
			valid: false,
			plan: plan.configDigest,
			live: '',
			message: 'live catalog config_digest is required',
		};
	}
	if (live !== plan.configDigest) {
		return {
			valid: false,
			plan: plan.configDigest,
			live,
			message: `plan is stale: catalog digest changed (plan ${plan.configDigest}, live ${live})`,
		};
	}
	return { valid: true, plan: plan.configDigest, live, message: '' };
}

export function catalogDigestJson(check: CatalogDigestCheck): IDataObject {
	return {
		valid: check.valid,
		plan: check.plan,
		live: check.live,
		message: check.message,
	};
}

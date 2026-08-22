import { v5 as uuidV5 } from 'uuid';

const COMPETITION_ID_NAMESPACE = '536ba9f7-6f14-5a09-8f40-4dbac0be2f1f';

export function stableCompetitionId(designId: string, localRef: string): string {
	return uuidV5(`${designId}:${localRef}`, COMPETITION_ID_NAMESPACE);
}

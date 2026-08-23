interface ScoreInput {
	name: string;
	score: number | string;
	enabled: boolean;
	override: boolean;
	category: string;
}

export function transform(input: ScoreInput) {
	const output: Record<string, unknown> = { ...input };
	if (!(((input?.score ?? null) as number) >= 0 && ((input?.score ?? null) as number) <= 100)) {
		throw new Error('score must be in range');
	}
	output.adjustedScore = ((input?.score ?? null) as number) * 1.1 + 2;
	output.displayName = input?.name ?? null;
	output.active = Boolean(input?.enabled ?? null);
	output.status = ((input?.score ?? null) as number) >= 60 ? 'ready' : 'review';
	output.summary = {
		passed: ((input?.score ?? null) as number) >= 60,
		tags: ['imported', input?.category ?? null],
	};
	if (
		(((input?.score ?? null) as number) >= 60 && Boolean(input?.enabled ?? null)) ||
		(input?.override ?? null)
	) {
		output.accepted = true;
	} else {
		delete output.accepted;
	}
	return output;
}

function transform(input) {
	const output = {};
	output.score = clampScore(input?.score ?? null, 0, 100);
	return output;
}

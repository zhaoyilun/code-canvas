function transform(input) {
	const output = { ...input };
	if (!((input?.score ?? null) >= 0 && (input?.score ?? null) <= 100)) {
		throw new Error('score must be between 0 and 100');
	}
	output.checked = true;
	return output;
}

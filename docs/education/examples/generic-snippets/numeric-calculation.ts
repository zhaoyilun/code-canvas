function transform(input) {
	const output = {};
	output.total = (input?.price ?? null) * (input?.quantity ?? null) + 2;
	return output;
}

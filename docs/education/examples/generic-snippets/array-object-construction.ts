function transform(input) {
	const output = {};
	output.summary = {
		label: 'basic',
		values: [1, input?.score ?? null, true],
	};
	return output;
}

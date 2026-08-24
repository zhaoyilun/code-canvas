function transform(input) {
	const output = {};
	output.value = Number(input?.value ?? null);
	return output;
}

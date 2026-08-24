function transform(input) {
	const output = { ...input };
	output.customerName = input?.name ?? null;
	delete output.name;
	return output;
}

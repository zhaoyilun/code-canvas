function transform(input) {
	const output = { ...input };
	delete output.secret;
	return output;
}

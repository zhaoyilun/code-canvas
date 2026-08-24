function transform(input) {
	const output = {};
	if ((input?.score ?? null) >= 60 && Boolean(input?.active ?? null)) {
		output.level = 'pass';
	} else {
		output.level = 'review';
	}
	return output;
}

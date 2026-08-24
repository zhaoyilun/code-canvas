function transform(input) {
	const output = {};
	output.asNumber = Number('42.5');
	output.asText = String(false);
	output.isEnabled = Boolean(input?.enabled ?? null);
	return output;
}

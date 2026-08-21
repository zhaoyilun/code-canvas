import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		include: ['src/features/shared/editors/components/BlocklyEditor/payload.test.ts'],
	},
});

import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [vue()],
	resolve: {
		alias: {
			'@n8n/design-system': fileURLToPath(
				new URL('../../../../../../../@n8n/design-system/src', import.meta.url),
			),
			'@n8n/i18n': fileURLToPath(new URL('../../../../../../../@n8n/i18n/src', import.meta.url)),
		},
	},
	test: {
		environment: 'jsdom',
		globals: true,
		include: [
			'src/features/shared/editors/components/BlocklyEditor/payload.test.ts',
			'src/features/shared/editors/components/BlocklyEditor/robotSkills.test.ts',
			'src/features/shared/editors/components/BlocklyEditor/BlocklyEditor.test.ts',
		],
	},
});

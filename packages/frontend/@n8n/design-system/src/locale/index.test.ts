import { computed } from 'vue';

const loadLocale = async () => {
	vi.resetModules();
	return await import('./index');
};

describe('design-system locale', () => {
	it('loads simplified Chinese and refreshes reactive component labels', async () => {
		const locale = await loadLocale();
		const retryLabel = computed(() => locale.t('generic.retry', undefined));

		expect(retryLabel.value).toBe('Retry');

		await locale.use('zh-CN');

		expect(retryLabel.value).toBe('重试');
		expect(locale.t('formInput.validator.minCharactersRequired', { minimum: 8 })).toBe(
			'至少需要 8 个字符',
		);
	});

	it('keeps host translations as the first choice and falls back to the loaded locale', async () => {
		const locale = await loadLocale();
		await locale.use('zh-CN');

		locale.i18n((path) => (path === 'generic.retry' ? '来自宿主翻译' : path));

		expect(locale.t('generic.retry', undefined)).toBe('来自宿主翻译');
		expect(locale.t('generic.cancel', undefined)).toBe('取消');
	});
});

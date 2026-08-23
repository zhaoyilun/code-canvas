import CanvasHandleMainInput from './CanvasHandleMainInput.vue';
import { i18nInstance, setLanguage } from '@n8n/i18n';
import { createComponentRenderer } from '@/__tests__/render';
import {
	createCanvasHandleProvide,
	createCanvasProvide,
} from '@/features/workflows/canvas/__tests__/utils';

const renderComponent = createComponentRenderer(CanvasHandleMainInput);

describe('CanvasHandleMainInput', () => {
	it('should render correctly', async () => {
		const label = 'Test Label';
		const { container, getByText } = renderComponent({
			global: {
				provide: {
					...createCanvasProvide(),
					...createCanvasHandleProvide({ label }),
				},
			},
		});

		expect(container.querySelector('.canvas-node-handle-main-input')).toBeInTheDocument();
		expect(getByText(label)).toBeInTheDocument();
	});

	it('should localize numbered input labels for the teaching workbench', () => {
		const previousLocale = i18nInstance.global.locale.value;
		setLanguage('zh-CN');

		try {
			const { getByText, queryByText } = renderComponent({
				global: {
					provide: {
						...createCanvasProvide(),
						...createCanvasHandleProvide({ label: 'Input 2' }),
					},
				},
			});

			expect(getByText('输入 2')).toBeInTheDocument();
			expect(queryByText('Input 2')).not.toBeInTheDocument();
		} finally {
			setLanguage(previousLocale);
		}
	});
});

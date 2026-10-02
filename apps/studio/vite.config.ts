import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
	plugins: [vue()],
	server: {
		port: 5173,
		strictPort: true,
	},
	// 组件测试要 DOM 环境（vitest 默认是 node），显式给 happy-dom。
	test: {
		environment: 'happy-dom',
	},
});

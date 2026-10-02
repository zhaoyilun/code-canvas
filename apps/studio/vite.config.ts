import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
	plugins: [vue()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			/**
			 * 「生成」那一步要调 LLM，但 API key 不能进浏览器：
			 * 前端只请求同源的 `/llm/*`，key 在这一层（dev server 进程）注入。
			 * 端点与 key 都从环境变量读——`LLM_BASE_URL` / `LLM_API_KEY`，取不到就退到 DeepSeek。
			 */
			'/llm': {
				target: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/llm/, ''),
				configure: (proxy) => {
					proxy.on('proxyReq', (proxyReq) => {
						const key = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '';
						if (key !== '') proxyReq.setHeader('authorization', `Bearer ${key}`);
					});
				},
			},
		},
	},
	// 组件测试要 DOM 环境（vitest 默认是 node），显式给 happy-dom。
	test: {
		environment: 'happy-dom',
	},
});

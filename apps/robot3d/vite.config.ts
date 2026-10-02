import { defineConfig } from 'vitest/config';

export default defineConfig({
	server: {
		/**
		 * 5173 被 studio 占着（strictPort），这个应用固定用 5273，
		 * 两个可以同时开着：studio 编排任务，robot3d 看设备怎么动。
		 *
		 * host: true = IPv4/IPv6 都听。默认只听 ::1，于是 127.0.0.1 连不上——
		 * 给出去链接时两个写法都得能开。
		 */
		port: 5273,
		strictPort: true,
		host: true,
	},
	test: {
		// 执行器是纯计算，不需要 DOM；需要画布的测试自己显式声明环境。
		environment: 'node',
	},
});

#!/usr/bin/env node
/**
 * 假 bridge 的入口：先挂上 TS 解析钩子，再加载服务本体。
 *
 * 为什么要一个入口文件而不是 `node --import ./ts-resolve-hooks.mjs server.mjs`：
 * 起服务的人（人手敲、测试 spawn）只该记一条命令。用 `register()` + 动态 `import()`
 * 是因为静态 import 会先于 `register()` 求值——那样钩子还没挂上，装载就失败了。
 *
 * 用法：node tools/fake-bridge/start.mjs（环境变量见 README）
 */
import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.mjs', import.meta.url));
await import('./server.mjs');

/**
 * 代码面板（spec §4.1 的右栏 CODE）：**当前选中模块的实现**，只读。
 *
 * 「工作流上的一个模块 = 一个函数」：面板显示 `node.parameters.action` 指向的那个能力
 * 在目录里的 `implementation`（原语调用序列）。渲染规则在 `@codecanvas/code-render`，
 * 这里只管把结果画出来，外加常驻的任务级安全限值。
 *
 * 挂载点在外壳侧（`views/right/RightPanel.vue`）：
 * `import { CodePanel } from '../code-panel'`，固定在右栏下半块，不吃任何切换。
 */
export { default as CodePanel } from './CodePanel.vue';

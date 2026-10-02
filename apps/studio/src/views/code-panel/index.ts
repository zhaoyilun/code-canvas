/**
 * 代码面板（spec §4.1 的右栏 CODE）：声明 → 编译产物文本，只读。
 *
 * 挂载点在外壳侧（`views/right/RightPanel.vue`）：
 * `import { CodePanel } from '../code-panel'`，固定在右栏下半块，不吃任何切换。
 */
export { default as CodePanel } from './CodePanel.vue';

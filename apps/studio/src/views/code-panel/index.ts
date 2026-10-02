/**
 * 代码面板（spec §4.1 的右栏 CODE）：声明 → 编译产物文本，只读。
 *
 * 挂载点在外壳侧（`views/right/RightPanel.vue`）：
 * `import { CodePanel } from '../code-panel'`，在 blockly / workflow 两个 tab 下渲染。
 */
export { default as CodePanel } from './CodePanel.vue';

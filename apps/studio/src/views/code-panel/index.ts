/**
 * 代码面板（spec §4.1 的右栏 CODE）：**当前选中模块的实现**，只读。
 *
 * 「工作流上的一个模块 = 一个函数」：面板显示 `node.parameters.action` 指向的那个能力
 * 在目录里的 `implementation`——一棵**语句树**，由 `@codecanvas/code-render` 递归渲染成
 * 带缩进的代码（赋值、`if`、嵌套调用）。这里只管把结果画出来，外加常驻的任务级安全限值。
 *
 * 联动的那根线是 `state/document.ts` 的 `selectedStepIndex`：
 * 点代码某一行 → `selectStep(该行的顶层下标)`；`selectedStepIndex` 变了 → 属于那一步的行全亮。
 * 积木侧接的是同一个状态、同一套 `--cc-*` 高亮变量，所以两边说的「第几步」是同一件事。
 *
 * 挂载点在外壳侧（`views/right/RightPanel.vue`）：
 * `import { CodePanel } from '../code-panel'`，固定在右栏下半块，不吃任何切换。
 */
export { default as CodePanel } from './CodePanel.vue';

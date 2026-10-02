/**
 * Blockly 侧的积木定义、声明 ↔ 工作区的双向转换、主题，以及映射表的生成期部分。
 *
 * 积木的形状必须从校验器推导（`ACTION_SPECS` / `describeActionFields`），
 * 不许在这里手抄一份平行定义。见 docs/spec.md §4。
 *
 * 用法（视图侧只有三步）：
 * ```ts
 * const workspace = createCanvasWorkspace(host, paletteFromDocument()); // 建画布
 * const rendered = renderDeclaration({ workspace, declaration });        // 声明 → 积木
 * const compiled = compileWorkspace({ workspace, base: declaration });   // 积木 → 声明（不过则 ok=false）
 * ```
 */
export * from './palette';
export * from './blocks';
export * from './theme';
export * from './viewport';
export * from './identity';
export * from './render';
export * from './compile';
export * from './events';

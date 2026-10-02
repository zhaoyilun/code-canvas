/**
 * 五个工作区 tab 的唯一来源：左图标栏与顶部 tab 条都从这里读。
 * 图标名由 IconBase 解释（内联 SVG，不引图标库）。
 */
export type IconName = 'plan' | 'blocks' | 'flow' | 'sim' | 'hardware';

export type TabId = 'plan' | 'blockly' | 'workflow' | 'simulation' | 'hardware';

export interface Section {
	/** 稳定引用词法，也是 tab 的身份 */
	id: TabId;
	label: string;
	/** 左栏单字标记（图标栏窄，字比图好认） */
	glyph: string;
	icon: IconName;
}

export const SECTIONS: readonly Section[] = [
	{ id: 'plan', label: 'AI Plan', glyph: 'AI', icon: 'plan' },
	{ id: 'blockly', label: 'Blockly', glyph: '积', icon: 'blocks' },
	{ id: 'workflow', label: 'Workflow', glyph: '流', icon: 'flow' },
	{ id: 'simulation', label: 'Simulation', glyph: '仿', icon: 'sim' },
	{ id: 'hardware', label: 'Hardware', glyph: '硬', icon: 'hardware' },
];

export const DEFAULT_TAB: TabId = 'plan';

export function labelOf(id: string): string {
	return SECTIONS.find((section) => section.id === id)?.label ?? id;
}

export function isTabId(id: string): id is TabId {
	return SECTIONS.some((section) => section.id === id);
}

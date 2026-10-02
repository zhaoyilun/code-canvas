/**
 * 工作区事件 → 两类回调：参数可能变了（要重编译）、选中变了（要推给 store）。
 *
 * 视口缩放、拖动这些纯外观事件一律不进回调——它们不影响声明，
 * 让它们触发重写只会制造无意义的写回。
 */
import * as Blockly from 'blockly';
import type { BlockIdentity, BlockIndex } from './identity';

/** 会改变参数的积木事件：字段改动、增删块，以及从工具箱拖出来的落位。 */
export const PARAMETER_EVENT_TYPES: ReadonlySet<string> = new Set([
	Blockly.Events.BLOCK_CHANGE,
	Blockly.Events.BLOCK_CREATE,
	Blockly.Events.BLOCK_DELETE,
	Blockly.Events.BLOCK_MOVE,
]);

export interface WorkspaceObservers {
	readonly onParametersChange: () => void;
	readonly onSelectionChange: (blockId: string | null) => void;
}

export const observeWorkspace = (workspace: Blockly.Workspace, observers: WorkspaceObservers): (() => void) => {
	const listener = (event: Blockly.Events.Abstract): void => {
		if (event instanceof Blockly.Events.Selected) {
			observers.onSelectionChange(event.newElementId ?? null);
			return;
		}
		if (event instanceof Blockly.Events.BlockChange && event.element !== 'field') return;
		if (PARAMETER_EVENT_TYPES.has(event.type)) observers.onParametersChange();
	};

	workspace.addChangeListener(listener);
	return () => {
		workspace.removeChangeListener(listener);
	};
};

/** 选中的块或节点 → 统一的身份。块优先：点积木是这套联动的入口。 */
export const resolveSelection = (
	index: BlockIndex,
	selectedBlockId: string | null,
	selectedNodeId: string | null,
): BlockIdentity | null => {
	if (selectedBlockId !== null) {
		const byBlock = index.byBlockId.get(selectedBlockId);
		if (byBlock !== undefined) return byBlock;
	}
	if (selectedNodeId !== null) return index.byNodeId.get(selectedNodeId) ?? null;
	return null;
};

export const highlightBlock = (workspace: Blockly.WorkspaceSvg, blockId: string | null): void => {
	workspace.highlightBlock(blockId);
};

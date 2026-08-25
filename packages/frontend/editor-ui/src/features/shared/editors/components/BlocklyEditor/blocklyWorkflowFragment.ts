import type { WorkflowFragmentV1 } from '@n8n/dual-canvas-core';
import type { IConnections, INode, INodeConnections, NodeConnectionType } from 'n8n-workflow';
import { isNodeConnectionType } from 'n8n-workflow';

import type { WorkflowDocumentStore } from '@/app/stores/workflowDocument.store';

type FragmentWorkflowData = Pick<
	ReturnType<WorkflowDocumentStore['getSnapshot']>,
	'nodes' | 'connections'
>;
const BLOCKLY_CODE_NODE_TYPE = 'n8n-nodes-blockly-code.blocklyCode';

export function replaceWorkflowWithFragment(
	workflowDocumentStore: WorkflowDocumentStore,
	fragment: WorkflowFragmentV1,
	previousFragmentNodeRefs?: ReadonlySet<string>,
): boolean {
	const snapshot = workflowDocumentStore.getSnapshot();
	const fragmentNodeRefs = new Set(fragment.nodes.map((node) => node.nodeRef));
	const isSingleBlocklyShell =
		snapshot.nodes.length === 1 && snapshot.nodes[0]?.type === BLOCKLY_CODE_NODE_TYPE;
	const isCurrentFragment = hasSameNodeIds(snapshot.nodes, fragmentNodeRefs);
	const isPreviousFragment =
		previousFragmentNodeRefs !== undefined &&
		hasSameNodeIds(snapshot.nodes, previousFragmentNodeRefs);

	if (!isSingleBlocklyShell && !isCurrentFragment && !isPreviousFragment) return false;

	const workflowData = mapWorkflowFragment(fragment);

	workflowDocumentStore.hydrate({
		...snapshot,
		...workflowData,
		pinData: {},
		nodeGroups: [],
	});

	return true;
}

export function mapWorkflowFragment(fragment: WorkflowFragmentV1): FragmentWorkflowData {
	const namesByNodeRef = createUniqueNodeNames(fragment);
	const nodes = fragment.nodes.map<INode>((node) => ({
		id: node.nodeRef,
		name: requireNodeName(namesByNodeRef, node.nodeRef),
		type: node.nodeType,
		typeVersion: node.typeVersion,
		position: [node.position.x, node.position.y],
		parameters: node.parameters as unknown as INode['parameters'],
		...(node.credentials === undefined ? {} : { credentials: node.credentials }),
		...(node.disabled === undefined ? {} : { disabled: node.disabled }),
	}));
	const connections: IConnections = {};

	for (const connection of fragment.connections) {
		const sourceName = requireNodeName(namesByNodeRef, connection.from.nodeRef);
		const targetName = requireNodeName(namesByNodeRef, connection.to.nodeRef);
		const sourcePort = requireConnectionType(connection.from.port);
		const targetPort = requireConnectionType(connection.to.port);
		const sourceConnections: INodeConnections = connections[sourceName] ?? {};
		const portConnections = sourceConnections[sourcePort] ?? [];

		while (portConnections.length <= connection.from.index) portConnections.push(null);
		const outputConnections = portConnections[connection.from.index] ?? [];
		outputConnections.push({
			node: targetName,
			type: targetPort,
			index: connection.to.index,
		});
		portConnections[connection.from.index] = outputConnections;

		sourceConnections[sourcePort] = portConnections;
		connections[sourceName] = sourceConnections;
	}

	return { nodes, connections };
}

function createUniqueNodeNames(fragment: WorkflowFragmentV1): Map<string, string> {
	const namesByNodeRef = new Map<string, string>();
	const usedNames = new Set<string>();

	for (const node of fragment.nodes) {
		let name = node.label;
		let suffix = 2;
		while (usedNames.has(name)) name = `${node.label} ${suffix++}`;
		usedNames.add(name);
		namesByNodeRef.set(node.nodeRef, name);
	}

	return namesByNodeRef;
}

function requireConnectionType(port: string): NodeConnectionType {
	if (isNodeConnectionType(port)) return port;
	throw new Error(`工作流片段包含未知连接端口：${port}`);
}

function requireNodeName(namesByNodeRef: ReadonlyMap<string, string>, nodeRef: string): string {
	const name = namesByNodeRef.get(nodeRef);
	if (name !== undefined) return name;
	throw new Error(`工作流片段包含未知节点：${nodeRef}`);
}

function hasSameNodeIds(
	nodes: ReadonlyArray<{ id: string }>,
	expectedNodeIds: ReadonlySet<string>,
): boolean {
	return (
		nodes.length === expectedNodeIds.size && nodes.every((node) => expectedNodeIds.has(node.id))
	);
}

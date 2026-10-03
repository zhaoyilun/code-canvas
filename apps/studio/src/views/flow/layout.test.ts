/**
 * 自动布局：**同一张图永远给同一份坐标**，节点不重叠，分支的两条臂分得开。
 *
 * 这三条是「画出来」这件事的地基：铺开动画里框不能自己挪（所以布局必须是纯函数、
 * 一次算完），两条臂挤在一起的话那个分支就白画了，而重叠会让人以为两个节点是一回事。
 */
import { describe, expect, it } from 'vitest';
import { TEACHING_SPEC_FIXTURE } from '../../state/__fixtures__/teaching-spec';
import { edgeLabelText, fitText, flowNodeSize, layoutFlowGraph, pathOf } from './layout';

const overlapArea = (
	first: { x: number; y: number; width: number; height: number },
	second: { x: number; y: number; width: number; height: number },
): number => {
	const width = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
	const height = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
	return width > 0 && height > 0 ? width * height : 0;
};

describe('流程图布局（dagre）', () => {
	it('每个节点都有位置，且跟声明顺序无关（坐标只由这张图决定）', () => {
		const layout = layoutFlowGraph(TEACHING_SPEC_FIXTURE.flow);
		expect(layout.nodes).toHaveLength(TEACHING_SPEC_FIXTURE.flow.nodes.length);
		expect(layout.edges).toHaveLength(TEACHING_SPEC_FIXTURE.flow.edges.length);
		for (const node of layout.nodes) {
			expect(Number.isFinite(node.x)).toBe(true);
			expect(Number.isFinite(node.y)).toBe(true);
			expect(node.width).toBeGreaterThan(0);
		}
		// 再算一次：一模一样（铺开动画靠这一条——框不许自己挪）。
		expect(layoutFlowGraph(TEACHING_SPEC_FIXTURE.flow)).toEqual(layout);
	});

	it('开始节点在最上面、结束节点在最下面（自上而下的层次）', () => {
		const layout = layoutFlowGraph(TEACHING_SPEC_FIXTURE.flow);
		const start = layout.nodes.find((node) => node.id === 'start');
		const end = layout.nodes.find((node) => node.id === 'end');
		expect(start?.y).toBeLessThan(end?.y ?? 0);
	});

	it('没有两个框叠在一起', () => {
		const layout = layoutFlowGraph(TEACHING_SPEC_FIXTURE.flow);
		for (const [index, first] of layout.nodes.entries()) {
			for (const second of layout.nodes.slice(index + 1)) {
				expect(overlapArea(first, second)).toBe(0);
			}
		}
	});

	it('一个分支的两条臂分得开：一个在左、一个在右，两条边各有自己的折线', () => {
		const layout = layoutFlowGraph(TEACHING_SPEC_FIXTURE.flow);
		const thenNode = layout.nodes.find((node) => node.id === 'plan');
		const elseNode = layout.nodes.find((node) => node.id === 'again');
		expect(thenNode).toBeDefined();
		expect(elseNode).toBeDefined();
		expect(Math.abs((thenNode?.x ?? 0) - (elseNode?.x ?? 0))).toBeGreaterThan(1);
		const thenEdge = layout.edges.find((item) => item.edge.arm === 'then');
		const elseEdge = layout.edges.find((item) => item.edge.arm === 'else');
		expect(pathOf(thenEdge?.points ?? [])).not.toBe(pathOf(elseEdge?.points ?? []));
	});

	it('每条边都有折线（至少两个点），线上那句话落在某一个点上', () => {
		const layout = layoutFlowGraph(TEACHING_SPEC_FIXTURE.flow);
		for (const edge of layout.edges) {
			expect(edge.points.length, edge.key).toBeGreaterThanOrEqual(2);
			expect(pathOf(edge.points).startsWith('M ')).toBe(true);
			expect(Number.isFinite(edge.labelAt.x)).toBe(true);
		}
	});

	it('框的大小只由那两行字决定：detail 多一行就高一档，宽有上下限', () => {
		const plain = flowNodeSize({ id: 'a', kind: 'action', title: '看一眼桌面' });
		const detailed = flowNodeSize({ id: 'a', kind: 'action', title: '看一眼桌面', detail: 'pose_name=observe_table' });
		expect(detailed.height).toBeGreaterThan(plain.height);
		const long = flowNodeSize({ id: 'a', kind: 'action', title: '名'.repeat(200) });
		expect(long.width).toBeLessThanOrEqual(300);
	});

	it('线上写什么：模型给了就用它，分支臂没给时写「是 / 否」，其余不写', () => {
		expect(edgeLabelText({ from: 'a', to: 'b', arm: 'then', label: '看到了' })).toBe('看到了');
		expect(edgeLabelText({ from: 'a', to: 'b', arm: 'else' })).toBe('否');
		expect(edgeLabelText({ from: 'a', to: 'b' })).toBe('');
	});

	it('太长的字截到框里，但只截显示那一段（完整的话在 title 里）', () => {
		const fitted = fitText('一二三四五六七八九十', 13, 60);
		expect(fitted.endsWith('…')).toBe(true);
		expect(fitted.length).toBeLessThan('一二三四五六七八九十'.length);
		expect(fitText('短', 13, 60)).toBe('短');
	});
});

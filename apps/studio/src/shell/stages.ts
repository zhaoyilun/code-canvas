/**
 * 底部六段流水线。
 *
 * 关键约束：本阶段不执行任何东西，所以只有前三段（导入 / 校验 / 编译）可达；
 * 后三段是「尚未实现」，不是「等待中」——它们不可点亮、不可切换，也不显示任何编造的状态。
 */
export interface Stage {
	/** 稳定引用词法 */
	id: string;
	label: string;
	/** 人类可读备注，灰置段用它说明为什么不可达 */
	hint: string;
	reachable: boolean;
}

export const STAGES: readonly Stage[] = [
	{ id: 'received', label: 'Received', hint: '任务 JSON 已导入', reachable: true },
	{ id: 'validated', label: 'Validated', hint: '已过校验器', reachable: true },
	{ id: 'simulation', label: 'Simulation', hint: '声明编译产物', reachable: true },
	{
		id: 'approved',
		label: 'Approved',
		hint: '本阶段不执行，审批未实现',
		reachable: false,
	},
	{ id: 'running', label: 'Running', hint: '本阶段不执行，执行器未实现', reachable: false },
	{ id: 'succeeded', label: 'Succeeded', hint: '本阶段不执行，无运行结果', reachable: false },
];

/** 前三段里的第一段，作为初始段 */
export const FIRST_REACHABLE_STAGE = 'received';

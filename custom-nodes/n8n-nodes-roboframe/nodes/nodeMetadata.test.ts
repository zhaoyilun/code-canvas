import { describe, expect, it } from 'vitest';

import { CompetitionDesign } from './CompetitionDesign/CompetitionDesign.node';
import { RobotCatalog } from './RobotCatalog/RobotCatalog.node';
import { RobotSkill } from './RobotSkill/RobotSkill.node';
import { RobotSkillPlan } from './RobotSkillPlan/RobotSkillPlan.node';
import { RobotStatus } from './RobotStatus/RobotStatus.node';
import { RobotTask } from './RobotTask/RobotTask.node';
import { RobotValidate } from './RobotValidate/RobotValidate.node';

describe('RoboFrame 节点中文界面元数据', () => {
	it('keeps stable node type names while presenting Chinese display names', () => {
		const nodes = [
			new CompetitionDesign(),
			new RobotCatalog(),
			new RobotStatus(),
			new RobotSkill(),
			new RobotSkillPlan(),
			new RobotValidate(),
			new RobotTask(),
		];

		expect(nodes.map((node) => node.description.name)).toEqual([
			'competitionDesign',
			'robotCatalog',
			'robotStatus',
			'robotSkill',
			'robotSkillPlan',
			'robotValidate',
			'robotTask',
		]);
		expect(nodes.map((node) => node.description.displayName)).toEqual([
			'AI 课程设计生成',
			'机器人能力目录',
			'机器人状态',
			'机器人技能',
			'机器人计划',
			'机器人计划校验',
			'机器人任务执行',
		]);
		expect(nodes.every((node) => /[\u4e00-\u9fff]/.test(node.description.subtitle ?? ''))).toBe(
			true,
		);
	});

	it('uses Chinese labels for the skill and validation panels without changing parameter keys', () => {
		const skill = new RobotSkill().description.properties;
		expect(skill.map((property) => property.name)).toEqual([
			'skill',
			'targetName',
			'placeName',
			'motionDirection',
			'motionDistance',
			'timeoutSec',
			'parametersJson',
			'validateFirst',
			'waitForResult',
		]);
		expect(skill.map((property) => property.displayName)).toContain('运动方向');

		const validation = new RobotValidate().description.properties;
		expect(validation[0]).toMatchObject({
			name: 'operation',
			displayName: '校验对象',
			options: [
				{ name: '计划', value: 'plan' },
				{ name: '单个动作（调试）', value: 'action' },
			],
		});
	});
});

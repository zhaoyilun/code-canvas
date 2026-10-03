/**
 * 四类计划步**各自的去向**：能送到 bridge 的、只能客户端自己做的、以及**没有地方可送**的。
 *
 * 为什么单独成一份导出的数据，而不是散在编译器的 `if` 里：这是这个包对外最要紧的一句实话，
 * 界面（流程卡上「这一步谁执行」、诊断面板）要与编译器的行为说同一句话。写两份迟早分叉
 * ——一份说「原语送不了」，另一份悄悄把它塞进 execute，界面就会显示一个根本不存在的执行。
 * `test/compile.test.ts` 钉住这份清单与 `compilePlanToCalls` 的实际行为一致。
 *
 * 三条 `where` 的含义（判据是**执行侧有没有这个端点**，不是我们做了没做）：
 * - `'bridge'`：有端点，编译出请求发过去（技能：`POST /v1/skills/execute` + 轮询 `GET /v1/tasks/{id}`）；
 * - `'client'`：bridge 不管这件事，它在客户端做（分支判条件、等待）；
 * - `'nowhere'`：**执行侧压根没有这个端点**——不是欠账，是边界（见 `primitive` 那条）。
 */
import type { SkillPlanStep } from '@codecanvas/contracts';

/** 一个计划步由谁执行。 */
export type StepPlacement = 'bridge' | 'client' | 'nowhere';

/** 一类计划步的去向。 */
export interface StepRouting {
	readonly step: SkillPlanStep['step'];
	readonly where: StepPlacement;
	/** 为什么是这一格。界面直接把这句话展示出来就是实话，不必再编一句。 */
	readonly note: string;
}

export const STEP_ROUTING: readonly StepRouting[] = [
	{
		step: 'skill',
		where: 'bridge',
		note: '走 POST /v1/skills/execute（202 立刻回），成败**只能**在客户端轮询 GET /v1/tasks/{task_id} 里读到——失败不进请求的响应',
	},
	{
		step: 'if',
		where: 'client',
		note: 'bridge 没有分支端点：条件读上一步轮询到的 success，在客户端选一条臂（两条臂都要编译出来，走哪条等运行时才知道）',
	},
	{
		step: 'wait',
		where: 'client',
		note: 'bridge 不参与等待：就是客户端真的等（可被取消打断）。它不更新 last.success——后面那个 if 看到的仍是等待之前那一步的结果',
	},
	{
		step: 'primitive',
		where: 'nowhere',
		note: '执行侧没有原语端点：bridge 的技能目录由 CLI 的 skill_templates 建出来（只有技能，没有原语），把原语名当技能发进 /v1/skills/execute 只会换来 404。**这不是「我们还没做」，是上游边界**——要送得先给 bridge（或 CLI）加一条原语通路',
	},
];

/** 取一类步的去向。清单里没有它就抛——加了一种步而忘了在这里说清它去哪儿，是缺陷不是缺省。 */
export const routingOf = (step: SkillPlanStep['step']): StepRouting => {
	const routing = STEP_ROUTING.find((entry) => entry.step === step);
	if (routing === undefined) throw new Error(`limits.ts 里没有 ${step} 这条去向`);
	return routing;
};

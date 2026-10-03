/**
 * 正在生成的那一份**半成品**，以及那行**原始文本**——**不是文档真相**，所以不放进 `state/document.ts`。
 *
 * 与 `device-run.ts` 里那个 `runningPlanPath` 是同一个量级、同一个位置：说的是"此刻屏幕上正
 * 显示着什么临时东西"的一次性状态，一次生成结束（成功或失败）就清空。真相（`declaration`）
 * 的寿命是整场会话甚至更久，两者混成一份，读的人就再也分不清"这张卡是定稿还是预览"。
 *
 * 三个 ref 各管一件事，**写入者只有入口带 `<TaskInputBand>`**：
 *
 * - `provisionalText`：模型的累积原文。界面那行原始文本读它；
 * - `provisionalPlan`：从同一段原文解析出来的半成品（含幽灵态声明）；文字为空时是 `null`；
 * - `provisionalGenerating`：是不是正在生成。流程画布靠它决定"改画幽灵态"还是"画真相"。
 *
 * ⚠ 这三样**都不参与** `loadTaskJson` / `applyDeclaration` 那条路。故意不留任何写入真相的
 * 入口：半成品没有任何办法变成真相，只能被下一次定稿整块换掉。
 */
import { ref, shallowRef } from 'vue';
import type { ProvisionalSkillPlan } from './provisional';

/** 模型的累积原文（还没校验）。空串 = 没有正在生成的东西。 */
export const provisionalText = ref('');

/** 半成品计划；`null` = 没有（没在生成、解析不出、或者格式还不支持半成品解析）。 */
export const provisionalPlan = shallowRef<ProvisionalSkillPlan | null>(null);

/** 正在生成。它与"原文非空"不是同一件事：传输层还没吐第一个字时，原文是空的，但确实在生成。 */
export const provisionalGenerating = ref(false);

/** 开始新一轮：先把上一次的残渣清掉，再立起"正在生成"（否则会有一瞬看到上一轮的幽灵卡）。 */
export function beginProvisional(): void {
	provisionalText.value = '';
	provisionalPlan.value = null;
	provisionalGenerating.value = true;
}

/** 收到一段（或一整份）文本：原文换新，同时重算半成品。解析不出来就只留原文。 */
export function updateProvisional(text: string, plan: ProvisionalSkillPlan | null): void {
	provisionalText.value = text;
	provisionalPlan.value = plan;
}

/**
 * 收尾：定稿一到、生成失败、或者这一次被中止，都走这里。
 *
 * 「定稿一到就整块换掉」这一条**不需要额外的切换动作**：幽灵态与真相是同一时刻两处不同的
 * 数据源，清掉幽灵态那一刻视图读的就是真相——中间没有"逐块替换"的窗口，也就不可能有一帧
 * 同时显示两套（判据在 `FlowView` 那个 `v-if`/`v-else` 上）。
 */
export function endProvisional(): void {
	provisionalText.value = '';
	provisionalPlan.value = null;
	provisionalGenerating.value = false;
}

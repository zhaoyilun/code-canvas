/**
 * 「设备正在跑哪一步」——**不是文档真相**，所以不放进 `state/document.ts`。
 *
 * 声明与选中说的是这份文档是什么、人在看哪一步，它们要在整场会话里立得住；
 * 而这个值说的是设备**此刻**在干什么，一次运行里的瞬时状态，跑完就没有了（回到 `null`）。
 * 两种寿命不同的东西混成一份，读的人就再也分不清「这一步被选中」是用户点的还是机器跑到的。
 *
 * 为什么放在 `shell/`：它是设备那条线的事，与 `devices.ts`（登记了哪些设备）同一层；
 * 三个视图里只有流程画布要读它，而写它的人只有一个——右栏的虚拟设备面板（它订着 `onPlanStep`，
 * 是唯一知道设备在干什么的地方）。一个 ref，一个写入者，不另立一份状态。
 *
 * 值是**执行路径**（`1.then.0` 这种，口径见 `views/shared/plan-structure.ts` 的 `nodeAtPlanPath`），
 * 不是节点 id：路径说的是「在计划的哪一格」，臂里同名的那一步与顶层那一步才分得开。
 */
import { ref } from 'vue';
import { EMPTY_RUN_TRACE, traceAfter, type RunTrace } from '../views/mapping/run-trace';

/** 正在跑的那一步的路径；`null` = 没有在跑（没开跑、跑完了、复位了，都是它）。 */
export const runningPlanPath = ref<string | null>(null);

/** 设备走到某一步了（每一步先报 `running` 的那一条写它）。 */
export function setRunningPlanPath(path: string): void {
	runningPlanPath.value = path;
}

/**
 * 这一趟的**动线状态**：在跑的那一步、刚下来的那一步、走过的那条路（都是节点 id）。
 *
 * 与 `runningPlanPath` 的区别：那个是**执行路径**（`1.then.0`，判"计划的哪一格"），
 * 这个是**节点 id**（判"图上哪个框"，三处视图的锚点口径）。
 * 转移表只有一份，在 `views/mapping/run-trace.ts`——这里只负责存与改，不自己推。
 */
export const runTrace = ref<RunTrace>(EMPTY_RUN_TRACE);

/** 图上那个框亮起来时调它（`nodeAtPlanPath` 换算好的节点 id；推不出节点就传 null）。 */
export function setRunningNode(nodeId: string | null): void {
	runTrace.value = traceAfter(runTrace.value, nodeId);
}

/** 没有正在跑的那一步了：跑完、复位、换设备、开始新的一趟，都走这里。 */
export function clearRunningPlanPath(): void {
	runningPlanPath.value = null;
	runTrace.value = traceAfter(runTrace.value, null);
}

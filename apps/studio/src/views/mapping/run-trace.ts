/**
 * 动线的状态：**此刻哪一步在跑**，以及**刚下来的那一步收在哪**。
 *
 * 为什么要有这个文件：连线（`LinkOverlay.vue`）回答「这三处说的是同一件事」，
 * 但它是一条**静态**的对应关系。产品的主张是「一份声明，四种表达，一次执行」——
 * 那句话得变成一个**动作**才看得见：光从流程卡出发，顺着线走到积木、走到代码行，
 * 最后落到 3D 里那只臂上。这个文件就是那道光的**位置**。
 *
 * 三件事定死了它长什么样：
 *
 * 1. **只由真实事件驱动。** 输入只有 `runningPlanPath`（`shell/device-run.ts`）——
 *    右栏面板在设备每一步的 `running` 事件里写它。这里没有定时器、没有「演一遍」，
 *    状态机的每一次转移都对应设备真的动了。所以本文件里不许出现 `setInterval`。
 *
 * 2. **两步记忆就够。** 需要的不是「跑过哪些」，而是两个：**在跑的那一步**、**刚下来的那一步**。
 *    前者点着光，后者「收住」（光淡出、线停在安静的亮色上）——「上一步收没收住」
 *    正是验收时要读的那条。再往前的不留：留一屏的历史会把当下的对比淹掉。
 *
 * 3. **新的一趟从头开始。** 从「没在跑」到「某一步在跑」是**开场**，不是换步：
 *    上一趟收住的那条尾巴不许跟到这一趟里（否则新任务的第 1 步一亮，
 *    上一条已经跑完的线还停在那儿，读起来像这一步连了两处）。
 *
 * 值是**节点 id**，不是执行路径：线是按 `data-node-id` 挂的（三处锚点同一个口径），
 * 路径 → 节点那一步换算由调用方走 `nodeAtPlanPath`，与另外两处视图是同一份判据。
 */

/** 动线此刻的两格记忆：在跑的那一步、刚下来的那一步。两者都是节点 id，可以是 null。 */
export interface RunTrace {
	readonly running: string | null;
	readonly settled: string | null;
}

/** 什么都没在跑（页面刚打开、跑完清掉了、复位了）。 */
export const EMPTY_RUN_TRACE: RunTrace = { running: null, settled: null };

/**
 * 这一步的状态：三档，缺一档就分不清「机器在这儿」与「这一步刚过去」。
 *
 * - `flowing`：正在跑。线点着，光在上面跑。
 * - `settled`：刚下来的那一步。光淡出去，线停在安静的亮色上——「这一步完了」。
 * - `idle`：没它的事。常态细虚线。
 */
export type RunPhase = 'idle' | 'flowing' | 'settled';

/**
 * 换了一步（或收工）之后的两格记忆。
 *
 * 转移表就三行，全是**事件**的意思，没有一处是猜的：
 *   - 同一个值 → 原样返回（设备把同一步报两次不该重放一遍动线）；
 *   - `null → 某一步` → 开场，尾巴清掉；
 *   - 其余（换步、以及收工那一跳 `某一步 → null`）→ 刚下来的那一步进「收住」。
 *
 * 「收工」也走第三条：跑完时最后一步的线要能看出「这一步完了」，
 * 而不是啪一下回到常态虚线。它停在那儿，直到下一趟开场把它清掉。
 */
export const traceAfter = (trace: RunTrace, running: string | null): RunTrace => {
	if (running === trace.running) return trace;
	if (trace.running === null) return { running, settled: null };
	return { running, settled: trace.running };
};

/** 某个节点此刻处于哪一档。在跑的赢过收住的——两步重合时（一步跑两遍）亮的是「在跑」。 */
export const phaseOf = (trace: RunTrace, nodeId: string): RunPhase => {
	if (trace.running !== null && trace.running === nodeId) return 'flowing';
	if (trace.settled !== null && trace.settled === nodeId) return 'settled';
	return 'idle';
};

/**
 * 任务 JSON 视图（右栏下半块的一个 tab）：**当前声明按它出生时的格式还原出来的任务 JSON**，只读。
 *
 * 它和代码面板是同一件事的两种看法：代码面板看「选中模块**内部**怎么做」，
 * 这里看「整份任务**对外**是什么」。两者共用一个选中状态（`state/document.ts`），
 * 所以从这边点一段，另外三个视图立刻跟着跳。
 *
 * 数据一侧（还原 + 参数映射）在 `task-json.ts` 里，是纯函数，可以单独测。
 * 还原用的是**声明出生时那台设备的格式**（`document.ts` 的 `declarationFormatRef`），
 * 不是当前选中的设备——换设备不改写已经产出的声明。
 */
export { default as TaskJsonPanel } from './TaskJsonPanel.vue';
export {
	buildTaskJson,
	capabilityOf,
	capabilityRefOf,
	referencedStepIndex,
	renderTaskJson,
	type CatalogResolver,
	type TaskJsonLine,
	type TaskJsonSection,
	type TaskJsonView,
} from './task-json';

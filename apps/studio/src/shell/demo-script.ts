/**
 * **演示脚本**（只在 URL 带 `?demo=1` 时生效，平时一行都不跑）。
 *
 * 为什么要有这个东西：录屏/自动化要"敲字 → 生成 → 运行 → 跟着跑"这一串动作，
 * 而从外面驱动（CDP 的 `Runtime.evaluate`）在**推帧录屏**时不可靠——
 * screencast 的帧消息会把信道灌满，插进去的指令会静默失败（实测：设值返回 undefined、
 * 输入框一个字都没进去，录到一整段空场）。
 *
 * 所以把驱动搬进页面自己：它按固定节奏走完一串动作，外部只管开录。
 *
 * 纪律：
 * - **只认 `?demo=1`**，默认不加载任何东西、不排任何计时器；
 * - 每一步之间留够时间（打字要看得见、生成要等铺开、跑设备要等账本说"计划完成"）；
 * - 中途任一步失败就停下并 `console.warn`，**不硬撑**（录出来要能当证据，不能是演的）。
 */
import { setSelectedDevice } from './devices';
import { useTeaching } from '../state/teaching';

/** 演示用的那句话（与既有素材同一句，便于对照）。 */
export const DEMO_INSTRUCTION =
	'先看一眼桌面，成功就往前挪一点，没成功就退回安全位，然后张开夹爪，等一秒，最后把夹爪合上';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个条件成立，超时就放弃并说清是哪一步。 */
const waitFor = async (what: string, ok: () => boolean, timeoutMs: number): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (ok()) return true;
		await sleep(200);
	}
	console.warn(`[demo] 等不到：${what}（${String(timeoutMs)}ms 超时）`);
	return false;
};

/** 当前路径上带不带 `demo=1`。 */
export const demoRequested = (): boolean => {
	if (typeof window === 'undefined') return false;
	return new URLSearchParams(window.location.search).get('demo') === '1';
};

/**
 * 跑一遍演示。返回一个 Promise，走完（或中途失败）时落定。
 *
 * 由 `App.vue` 在挂载后**只在 `?demo=1` 时**调用一次。
 */
export const runDemoScript = async (): Promise<void> => {
	setSelectedDevice('so101_sim');
	await sleep(600);

	// ① 敲字：一个字一个字进去，录屏里看得见是在打这句话
	const input = document.querySelector<HTMLInputElement>('[data-testid="instruction-input"]');
	if (input === null) {
		console.warn('[demo] 找不到输入框，停在这里');
		return;
	}
	input.focus();
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
	for (let i = 1; i <= DEMO_INSTRUCTION.length; i += 1) {
		setter?.call(input, DEMO_INSTRUCTION.slice(0, i));
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await sleep(45);
	}
	await sleep(600);

	// ② 生成
	document.querySelector<HTMLButtonElement>('[data-testid="task-generate"]')?.click();
	const teaching = useTeaching();
	const drawn = await waitFor('教学规格铺开', () => teaching.revealedCodeLines.value.length > 20, 180_000);
	if (!drawn) return;
	await sleep(2600);

	// ③ 跑设备：点界面上那个「运行」（和用户点的是同一个按钮——
	//    这样录出来的东西才有意义，不是绕开界面直接调内部函数）
	const runButton = [...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === '运行',
	);
	if (runButton === undefined) {
		console.warn('[demo] 找不到「运行」按钮，停在这里');
		return;
	}
	runButton.click();
	// 账本说"计划完成"就算跑完（与界面上那句话同一个判据）
	await waitFor('账本说计划完成', () => document.body.innerText.includes('计划完成'), 90_000);
	await sleep(3600);
	console.log('[demo] 走完一遍');
};

/**
 * 界面审计：开一个真标签页 → 灌一份样例任务 → 整页截图 + 把关键区域的计算样式量出来。
 *
 * 用法：node tools/ui-audit/audit.mjs <out.png> [label]
 * 前置：studio dev server 在 5173，Chrome 的 CDP 在 9223。
 *
 * 为什么走「点生成」而不是「粘贴样例 JSON」：粘贴那条路只出声明，**不出积木与代码**
 * （教学规格是第二次模型调用产出的，粘贴不触发它）。而这一屏最要看的就是积木和代码的字，
 * 所以走生成。代价是两次跑出来的计划可能不一样——所以对比时只看字号与配色，不看文字内容，
 * 那两样是 `theme.css` 的变量决定的，与模型无关。
 */
import { writeFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9223';
const APP = 'http://localhost:5173/';
const out = process.argv[2] ?? '/tmp/cc-audit.png';
const label = process.argv[3] ?? '';

/** 与演示视频同一句，保证两次跑的是同一件事。 */
const INSTRUCTION = '先看一眼桌面，成功就往前挪一点，没成功就退回安全位，然后张开夹爪，等一秒，最后把夹爪合上';

const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
	const message = JSON.parse(event.data);
	if (message.id && pending.has(message.id)) {
		pending.get(message.id)(message);
		pending.delete(message.id);
	}
});
const send = (method, params = {}) =>
	new Promise((resolve) => {
		const current = ++id;
		pending.set(current, resolve);
		ws.send(JSON.stringify({ id: current, method, params }));
	});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = async (expression) => {
	const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (result.result?.exceptionDetails) {
		throw new Error(`页面里抛了：${result.result.exceptionDetails.exception?.description ?? '?'}`);
	}
	return result.result?.result?.value;
};

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Page.enable');
// 跟演示视频同一档画面：1680×1050。
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
const win = await send('Browser.getWindowForTarget');
const wid = win.result.windowId;
const bounds = win.result.bounds;
await send('Browser.setWindowBounds', { windowId: wid, bounds: { ...bounds, width: bounds.width - 40 } });
await sleep(600);
await send('Browser.setWindowBounds', { windowId: wid, bounds });
await sleep(500);

await send('Page.navigate', { url: APP });
await sleep(6000);

// 选虚拟设备（SO-101 仿真）——演示用的就是这一台。
const picked = await js(`(() => {
  const select = document.querySelector('[data-testid="device-select"]');
  if (!select) return 'no-select';
  select.value = 'so101_sim';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return select.value;
})()`);
await sleep(2000);

// 灌那句话并生成（第一次调用出任务计划，第二次出教学规格）。
const filled = await js(`(() => {
  const input = document.querySelector('[data-testid="instruction-input"]');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(INSTRUCTION)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value.length;
})()`);
await sleep(500);
const converted = await js(`(() => {
  const button = document.querySelector('[data-testid="task-generate"]');
  if (!button) return 'no-button';
  if (button.disabled) return 'disabled';
  button.click();
  return 'clicked';
})()`);

// 两次模型调用：任务计划 + 教学规格。等到三张图里出现内容，或超时。
const deadline = Date.now() + 150000;
let waiting = null;
while (Date.now() < deadline) {
	await sleep(2500);
	waiting = await js(`(() => ({
	  drawing: document.querySelector('[data-testid="blockly-drawing"]') !== null,
	  codeLines: document.querySelectorAll('[data-testid="code-line"]').length,
	  flowNodes: document.querySelectorAll('[data-testid="flow-node-action"]').length,
	  empty: document.querySelector('[data-testid="blockly-empty"]') !== null,
	  failed: document.querySelector('[data-testid="blockly-failed"]') !== null,
	  note: (document.querySelector('[data-testid="blockly-linkage-note"]') || {}).textContent ?? null,
	}))()`);
	if (waiting.codeLines > 0 && waiting.flowNodes > 0) break;
	if (waiting.failed) break;
}
await sleep(2500);

// 量取：关键区域的实际字号、颜色、对比度，以及三张图有没有画出来。
const probe = await js(String.raw`(() => {
  const rgb = (c) => { const m = (c || '').match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
  const lum = (c) => {
    const v = rgb(c); if (!v) return null;
    const [r, g, b] = v.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    if (l1 == null || l2 == null) return null;
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  const describe = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const bg = bgOf(el);
    const box = el.getBoundingClientRect();
    return {
      text: (el.textContent || '').trim().slice(0, 40),
      font: cs.fontSize,
      color: cs.color,
      bg,
      contrast: ratio(cs.color, bg),
      box: [Math.round(box.width), Math.round(box.height)],
    };
  };
  const pick = (selector, index = 0) => describe(document.querySelectorAll(selector)[index] ?? null);

  const samples = {
    '面板标题(虚拟设备)': pick('[data-testid="device-panel-title"], .panel-title'),
    '设备事实行': pick('[data-testid="task-endpoint-device"] span'),
    '流程卡·动作名': pick('[data-testid="flow-node-action"]'),
    '流程卡·步骤号': pick('[data-testid="flow-node-step"]'),
    '流程卡·参数值': pick('[data-testid="flow-node-params"] dd'),
    '流程卡·参数名': pick('[data-testid="flow-node-params"] dt'),
    '代码行': pick('[data-testid="code-line"]', 3),
    '代码面板标题': pick('[data-testid="code-panel-title"]'),
    '积木画布标题': pick('[data-testid="blockly-title"]'),
    '积木块内文字': pick('[data-testid="blockly-canvas"] text'),
  };

  const fonts = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    if (el.children.length !== 0) return;
    const t = (el.textContent || '').trim();
    if (t.length < 2) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    fonts.add(cs.fontSize);
  });

  return {
    url: location.href,
    viewport: [innerWidth, innerHeight],
    device: (document.querySelector('[data-testid="device-select"]') || {}).value ?? null,
    rendered: {
      flowNodes: document.querySelectorAll('[data-testid="flow-node-action"]').length,
      blocks: document.querySelectorAll('[data-testid="blockly-block-count"]').length,
      codeLines: document.querySelectorAll('[data-testid="code-line"]').length,
      blocklyEmpty: document.querySelector('[data-testid="blockly-empty"]') !== null,
      blocklyFailed: document.querySelector('[data-testid="blockly-failed"]') !== null,
    },
    fontSizes: [...fonts].map((f) => parseFloat(f)).sort((a, b) => a - b),
    samples,
  };
})()`);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (!shot.result?.data) throw new Error(`截图失败：${JSON.stringify(shot).slice(0, 300)}`);
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));

const audit = { label, out, picked, filled, converted, ...probe };
writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(audit, null, 1));
console.log(JSON.stringify(audit, null, 1));
ws.close();

#!/usr/bin/env node
/**
 * **假 bridge**：一个开发替身，按上游契约说话，但不接机器人、不转发、不鉴权。
 *
 * 它**不是** bridge 的实现。真身在旧仓库 `services/roboframe-bridge`（FastAPI + robot-skill CLI
 * + ROS），这台机器上没有 ROS、没有 CLI，所以那条链一步都发不出去。这个替身把 HTTP 那一侧
 * 立起来，好让「下发 → 轮询 → 终态 → 据此选臂」在**真 HTTP**上跑通，而不是只做形状对账。
 *
 * 形状的判据不是这份文件，也不是上游的 README，而是 bridge 自己的 pydantic 模型：
 *   `docs/reference/bridge_models.py`（从上游 `roboframe_bridge/models.py` 抄来，commit 561f75f9）
 *   ←→ `packages/robot-bridge/src/models.ts`（zod 镜像，`test/model-parity.test.ts` 钉着两者一致）
 * 这里**直接 import 那份 zod 镜像**来校验进来的 body 与构造出去的响应——所以它不是「随便一个
 * 假服务」：形状对不上，它自己先拒。
 *
 * 两点不装：
 * - **不假装有鉴权**：`Authorization` 收任何值、不带也收（真身是 Bearer token）。
 * - **不假装有机器人**：任务的状态是定时器推的，`executed_primitives` 是从真目录的
 *   `implementation` 里读出来的（不是编的），但没有任何东西真的动。
 *
 * 环境变量 / 命令行参数（命令行优先）：
 *   FAKE_BRIDGE_PORT=8788           --port        监听端口；0 = 让系统挑一个（测试用），
 *                                                 挑中的端口会打在 `listening http://127.0.0.1:<port>`
 *   FAKE_BRIDGE_ROBOT=so101_single_arm --robot    冒充哪一台的配置；决定 robot_name 与技能表。
 *                                                 另一份是 so101_handeye_realsense_grasp（含抓取）。
 *                                                 想冒充两台就起两个进程、两个端口——上游一份配置一台机器
 *   FAKE_BRIDGE_STEP_MS=800         --step-ms     一步「走」多久才落终态（这之前轮询读到 executing）
 *   FAKE_BRIDGE_FAIL_SKILLS=a,b     --fail-skills 名单里的技能落 failed（默认全成功）
 *   FAKE_BRIDGE_UNKNOWN_SKILLS=a,b  --unknown-skills 名单里的技能**从目录里摘掉**：
 *                                                 execute 回 404、validate 回 valid:false（默认空）
 *
 * 每个请求打一行日志到 stdout（方法、路径、技能名、task_id、状态码），任务落终态再打一行
 * ——验收「真的发出去了」靠的就是这些行，格式见 README。
 */
import { createServer } from 'node:http';

// 相对路径而不是裸包名：`tools/` 不是 workspace 包，没有自己的 node_modules
// （裸 `@codecanvas/robot-bridge` 在 packages/robot-bridge/ 里才解析得到）。
import {
	cancelResultSchema,
	catalogSchema,
	executeAcceptedSchema,
	executeRequestSchema,
	healthSchema,
	taskResultSchema,
	TERMINAL_TASK_STATES,
	validateRequestSchema,
	validateResultSchema,
} from '../../packages/robot-bridge/src/models.ts';
import { ROBOFRAME_GRASP_CATALOG, ROBOFRAME_SO101_CATALOG } from '../../packages/capabilities/src/index.ts';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 命令行参数优先于环境变量：临时演示时不想先 export 一堆东西。 */
const argOf = (name) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
};

const configOf = (flag, env) => {
	const raw = argOf(flag) ?? process.env[env];
	return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
};

const numberFrom = (raw, fallback) => {
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const listFrom = (raw) =>
	(raw ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '');

const PORT = numberFrom(configOf('port', 'FAKE_BRIDGE_PORT'), 8788);
const STEP_MS = numberFrom(configOf('step-ms', 'FAKE_BRIDGE_STEP_MS'), 800);
const FAIL_SKILLS = new Set(listFrom(configOf('fail-skills', 'FAKE_BRIDGE_FAIL_SKILLS')));
const UNKNOWN_SKILLS = new Set(listFrom(configOf('unknown-skills', 'FAKE_BRIDGE_UNKNOWN_SKILLS')));

/** 版本号：只是让 `Health.version` 有个值（真身报的是自己包的版本）。 */
const FAKE_VERSION = 'fake-bridge-0';

// ---------------------------------------------------------------------------
// 技能目录：**来自真目录**（`@codecanvas/capabilities`），不是手写的一份
// ---------------------------------------------------------------------------

/**
 * 这个替身替的是**一台机器人配置**，所以目录要能挑：上游的 robot_config 一份配置一台机器，
 * 一台机器一个 bridge。两份真实配置（单臂 / 抓取）技能集不同，一个进程同时冒充两台
 * 只会让 `robot_name` 与技能表打架——想两台就起两个进程、两个端口。
 */
const CATALOGS = {
	so101_single_arm: ROBOFRAME_SO101_CATALOG,
	so101_handeye_realsense_grasp: ROBOFRAME_GRASP_CATALOG,
};

const ROBOT = configOf('robot', 'FAKE_BRIDGE_ROBOT') ?? 'so101_single_arm';
const CATALOG = CATALOGS[ROBOT];
if (CATALOG === undefined) {
	console.error(`不认识的机器人配置 ${ROBOT}（已知：${Object.keys(CATALOGS).join('、')}）`);
	process.exit(2);
}

/**
 * 「bridge 认识的技能」＝ 真目录里的 `capabilities[].capabilityRef`，减掉被要求装不认识的那些。
 * 手写一份假技能清单就失去了这次的意义——那样测出来的只是「假服务收了我编的东西」。
 */
const SKILLS = CATALOG.capabilities.filter((capability) => !UNKNOWN_SKILLS.has(capability.capabilityRef));
const SKILL_BY_NAME = new Map(SKILLS.map((capability) => [capability.capabilityRef, capability]));

/**
 * `GET /v1/catalog` 的响应。真身那份由 robot-skill CLI 从 `skill_templates` 建出来，
 * 名字对得上目录里的 `capabilityRef`（`execute` 就是拿它比的）。CLI 那一侧才有的几栏
 * （`domain` / `moves_robot` / `recovery_policy` / `timeout_policy`）这里只能填一个固定的说法
 * ——这个替身没有 CLI，就别假装有。`config_digest` 用目录的 `revisionRef`（它确实是上游那份
 * 配置的摘要），`robot_name` 用目录的 `robotName`。
 */
const catalogPayload = () =>
	catalogSchema.parse({
		robot_name: CATALOG.robotName,
		config_digest: CATALOG.revisionRef,
		skills: SKILLS.map((capability) => ({
			name: capability.capabilityRef,
			summary: capability.summary,
			domain: 'roboframe',
			moves_robot: true,
			// 参数只给「叫什么、什么类型、必不必填」——真身给的是 CLI 的 JSON Schema，
			// 这个替身只需要名字（execute 拿名字比目录），多的那一层不编。
			parameters: Object.fromEntries(
				capability.parameters.map((parameter) => [
					parameter.name,
					{ type: parameter.type, required: parameter.required === true, label: parameter.label },
				]),
			),
			recovery_policy: '',
			timeout_policy: {},
		})),
	});

/** 这个技能会下发哪些原语：从真目录的 `implementation` 里读（`executed_primitives` 不是编的）。 */
const primitivesOf = (capability) =>
	(capability?.implementation ?? [])
		.map((statement) => statement?.primitiveRef)
		.filter((name) => typeof name === 'string');

// ---------------------------------------------------------------------------
// 日志：每行一条，字段固定（验收与测试都从这些行里读证据）
// ---------------------------------------------------------------------------

const log = (line) => {
	process.stdout.write(`[fake-bridge] ${line}\n`);
};

// ---------------------------------------------------------------------------
// 任务注册表：状态由定时器推，成败由配置定
// ---------------------------------------------------------------------------

/** task_id → { task, timer }。真身的注册表在 bridge 进程里（`memory.TaskRegistry`），这里同形。 */
const tasks = new Map();

const newTask = (request) => ({
	task_id: request.task_id,
	skill: request.skill,
	state: 'executing',
	success: null,
	error_code: '',
	message: '',
	executed_primitives: [],
});

/**
 * 把任务推进到终态——**异步**，POST 的响应里没有成败（真身也是：`execute` 起一个线程、
 * 立刻回 202，成败只从注册表读得到）。`STEP_MS` 这段时间里轮询读到的是 `executing`，
 * 于是「轮询真的发生过」这件事在 HTTP 上是可观察的，而不是靠猜。
 */
const scheduleTerminal = (taskId, capability) => {
	const timer = setTimeout(() => {
		const task = tasks.get(taskId);
		if (task === undefined) return;
		// 取消过了就不再报终态（取消是终态，不许被后到的定时器覆盖回成功）
		if (TERMINAL_TASK_STATES.has(task.state)) return;

		if (FAIL_SKILLS.has(task.skill)) {
			task.state = 'failed';
			task.success = false;
			task.error_code = 'skill_failed';
			task.message = `假 bridge：技能「${task.skill}」在 FAKE_BRIDGE_FAIL_SKILLS 名单里，按配置失败`;
		} else {
			task.state = 'completed';
			task.success = true;
			task.executed_primitives = primitivesOf(capability);
		}
		log(`task ${taskId} -> ${task.state} success=${String(task.success)}`);
	}, STEP_MS);
	timer.unref?.();
	return timer;
};

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const json = (res, status, payload, extraHeaders = {}) => {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		...extraHeaders,
	});
	res.end(body);
};

/**
 * 出错的形状照 FastAPI 的 `HTTPException`（`{"detail": "..."}`），所以这里统一走一个 `detail` 栏
 * ——状态码那一处与真身不同（形状不对我们回 400，真身回 422），见 README。
 */
const readBody = (req) =>
	new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});

/** 把 zod 的结论压成一句话（给 400 的说明用：错在哪个字段、为什么）。 */
const explain = (error) =>
	error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.map(String).join('.') || '<根>'}: ${issue.message}`)
		.join('；');

/**
 * 处理一个请求，返回 `{ status, payload, skill, taskId }`。
 * `skill` / `taskId` 只为日志与「哪个 task 落终态」服务，不参与判据。
 */
const handle = async (method, path, rawBody) => {
	// --- 无鉴权的那一个端点（app.py 里唯一没挂守卫的）：健康检查 ---
	if (method === 'GET' && path === '/v1/health') {
		return { status: 200, payload: healthSchema.parse({ version: FAKE_VERSION }) };
	}

	if (method === 'GET' && path === '/v1/catalog') {
		return { status: 200, payload: catalogPayload() };
	}

	// --- 技能：校验与下发 ---
	if (method === 'POST' && (path === '/v1/skills/validate' || path === '/v1/skills/execute')) {
		let incoming;
		try {
			incoming = JSON.parse(rawBody === '' ? 'null' : rawBody);
		} catch (error) {
			return { status: 400, payload: { detail: `请求体不是 JSON：${String(error.message)}` } };
		}

		// 形状不对时也要能从日志里看出「是谁打过来的」——不然 400 那一行只剩一行空白
		const looseSkill = typeof incoming?.skill === 'string' ? incoming.skill : undefined;
		const looseTaskId = typeof incoming?.task_id === 'string' ? incoming.task_id : undefined;

		const schema = path === '/v1/skills/execute' ? executeRequestSchema : validateRequestSchema;
		const parsed = schema.safeParse(incoming);
		if (!parsed.success) {
			// 形状不对就 400 并说明——这一条是「它不是随便一个假服务」的地方：
			// 判据用的是 `@codecanvas/robot-bridge` 的 zod 镜像（与 pydantic 对过账的那一份）
			return {
				status: 400,
				payload: {
					detail: `请求体不合 ${path === '/v1/skills/execute' ? 'ExecuteRequest' : 'ValidateRequest'}：${explain(parsed.error)}`,
				},
				skill: looseSkill,
				taskId: looseTaskId,
			};
		}

		const request = parsed.data;
		const capability = SKILL_BY_NAME.get(request.skill);

		if (path === '/v1/skills/validate') {
			if (capability === undefined) {
				return {
					status: 200,
					payload: validateResultSchema.parse({
						valid: false,
						error_code: 'unknown_skill',
						message: `bridge 的技能目录里没有「${request.skill}」`,
					}),
					skill: request.skill,
				};
			}
			// **只回答「收不收这个技能」**：参数校验在真身那边是 CLI 的活，这个替身没有 CLI，
			// 所以它不假装会校验参数（ValidateResult 本来也不回答「跑起来成不成」）。
			return { status: 200, payload: validateResultSchema.parse({ valid: true }), skill: request.skill };
		}

		if (capability === undefined) {
			// 与真身一致：`execute` 拿请求里的 skill 比技能目录，不在就 404（app.py 第 98-99 行）
			return {
				status: 404,
				payload: { detail: `unknown skill: ${request.skill}` },
				skill: request.skill,
				// 请求被挡下来了、没有任务被建，但 task_id 是对方给的，日志里照实带上（便于对账）
				taskId: request.task_id,
			};
		}

		const task = newTask(request);
		task.timer = scheduleTerminal(request.task_id, capability);
		tasks.set(request.task_id, task);
		log(`task ${request.task_id} accepted skill=${request.skill} step_ms=${String(STEP_MS)}`);

		return {
			status: 202,
			payload: executeAcceptedSchema.parse({ task_id: request.task_id, skill: request.skill }),
			skill: request.skill,
			taskId: request.task_id,
		};
	}

	// --- 任务：查询与取消 ---
	const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(path);
	if (method === 'GET' && taskMatch !== null) {
		const taskId = decodeURIComponent(taskMatch[1]);
		const entry = tasks.get(taskId);
		// 与真身同一条口径：注册表里没有 → 404（app.py：registry.get 返回 None 之后再问 CLI，
		// 还是 None 就 404 unknown task）。**202 说收下了、这里却说不认识**＝这条链断了。
		if (entry === undefined) return { status: 404, payload: { detail: `unknown task: ${taskId}` }, taskId };
		return {
			status: 200,
			payload: taskResultSchema.parse(entry),
			taskId,
			// 真身会把同一个判断放进这个头（app.py 第 116 行）
			headers: { 'X-Terminal-State': String(TERMINAL_TASK_STATES.has(entry.state)) },
		};
	}

	const cancelMatch = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(path);
	if (method === 'POST' && cancelMatch !== null) {
		const taskId = decodeURIComponent(cancelMatch[1]);
		const entry = tasks.get(taskId);
		if (entry === undefined) {
			// 任务的真相在注册表里（口径同 GET）：不认识就没有可取消的东西
			return { status: 404, payload: { detail: `unknown task: ${taskId}` }, taskId };
		}
		if (TERMINAL_TASK_STATES.has(entry.state)) {
			return {
				status: 200,
				payload: cancelResultSchema.parse({
					task_id: taskId,
					requested: false,
					state: entry.state,
					message: '任务已经在终态，没有可取消的',
				}),
				taskId,
			};
		}

		// 取消是终态：先停掉那个还没到点的定时器，再落 canceled（否则它会随后把任务改成成功）
		clearTimeout(entry.timer);
		entry.state = 'canceled';
		entry.success = false;
		entry.message = '按请求取消（假 bridge：没有真的机器人可停）';
		log(`task ${taskId} -> canceled`);
		return {
			status: 200,
			payload: cancelResultSchema.parse({ task_id: taskId, requested: true, state: entry.state, message: entry.message }),
			taskId,
		};
	}

	return { status: 404, payload: { detail: `这个替身没有这条路由：${method} ${path}` } };
};

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
	void (async () => {
		const method = req.method ?? 'GET';
		const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

		// CORS：浏览器要发出去就得有（真身部署在机器人那侧，一般同源或走反代，没这一层；
		// 这个替身是给开发机上的页面用的，所以有）
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		if (method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			log(`${method} ${path} status=204`);
			return;
		}

		let outcome;
		try {
			const rawBody = method === 'POST' ? await readBody(req) : '';
			outcome = await handle(method, path, rawBody);
		} catch (error) {
			// 替身自己的 bug 也要看得见，别把 500 咽掉
			outcome = { status: 500, payload: { detail: `假 bridge 自己崩了：${String(error?.stack ?? error)}` } };
		}

		// 先落日志再回响应：**验收读的就是这些行**，早一行写下去，读的人就不必猜「它是不是还没到」
		log(
			`${method} ${path} skill=${outcome.skill ?? '-'} task=${outcome.taskId ?? '-'} status=${String(outcome.status)}`,
		);
		json(res, outcome.status, outcome.payload, outcome.headers ?? {});
	})().catch((error) => {
		log(`处理请求时崩了：${String(error?.stack ?? error)}`);
		try {
			res.destroy();
		} catch {
			// 连不上就算了——日志里已经有了
		}
	});
});

server.listen(PORT, '127.0.0.1', () => {
	const address = server.address();
	const bound = typeof address === 'object' && address !== null ? address.port : PORT;
	// 这一行是**端口发现**：PORT=0 时由系统挑，测试从这里读回真端口（不许硬编码端口）
	log(`listening http://127.0.0.1:${String(bound)}`);
	log(
		`config step_ms=${String(STEP_MS)} skills=${String(SKILLS.length)}` +
			` fail_skills=${FAIL_SKILLS.size === 0 ? '-' : [...FAIL_SKILLS].join(',')}` +
			` unknown_skills=${UNKNOWN_SKILLS.size === 0 ? '-' : [...UNKNOWN_SKILLS].join(',')}`,
	);
});

// 收到 SIGTERM / SIGINT 就干净地退出（测试 afterAll 会杀它）
for (const signal of ['SIGTERM', 'SIGINT']) {
	process.on(signal, () => {
		log(`收到 ${signal}，退出`);
		server.close(() => process.exit(0));
		// 还没来得及关的连接不该把退出拖住
		setTimeout(() => process.exit(0), 200).unref();
	});
}

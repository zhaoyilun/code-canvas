/**
 * 实现语句树的第四种语句：**委托**（`{kind:'delegate'}`）。
 *
 * 为什么单开一份测试：这一种不是「多加一个分支」，它换了一个前提——
 * 前三种语句都在说「这台设备怎么做」，`delegate` 说的是「**这里不做，做在执行侧**」。
 * 所以这里钉的是四件事：
 *
 * 1. 一条 `delegate` 进得了 schema，且原样回传（形状不被猜、不被补键）；
 * 2. `interfaceRef` 是**接口名**（`/manipulation/execute_pick`），不是原语名——
 *    空串、带空白的、`//`、结尾 `/`、以非字母数字开头的一律拒掉；
 * 3. `arguments` 与 `call` 是同一套 `ImplArgument`，所以 `{kind:'param'}` 表达得了
 *    「取值来自这个技能的参数」，非法参数名照样拒；
 * 4. 原有三种语句（`call` / `set` / `if`）一条没少——加一种不等于换一套。
 */
import { describe, expect, it } from 'vitest';
import { implStatementSchema, type ImplStatement } from '../src/capability';
import { interfaceReferenceSchema } from '../src/stable-ids';

const parse = (statement: unknown) => implStatementSchema.safeParse(statement);

/** 解析成功就给回语句本身，免得每个用例都写一遍 `if (!parsed.success) throw`。 */
const parsed = (statement: unknown): ImplStatement => {
	const result = parse(statement);
	if (!result.success) throw new Error(`预期能解析：${JSON.stringify(result.error.issues.slice(0, 2))}`);
	return result.data;
};

const DELEGATE: ImplStatement = {
	kind: 'delegate',
	interfaceRef: '/manipulation/execute_pick',
	arguments: { target_name: { kind: 'param', name: 'target_name' } },
};

describe('delegate 语句', () => {
	it('进得了 schema，且原样回传', () => {
		expect(parsed(DELEGATE)).toEqual(DELEGATE);
	});

	it('实参可以是字面量（与 call 同一套 ImplArgument）', () => {
		// 委托不等于「参数全靠外部」：该写死的照样写死，例如固定超时预算。
		expect(
			parsed({ kind: 'delegate', interfaceRef: '/manipulation/execute_pick', arguments: { timeout_sec: 240 } }),
		).toEqual({ kind: 'delegate', interfaceRef: '/manipulation/execute_pick', arguments: { timeout_sec: 240 } });
	});

	it('能长在 if 的分支里（它就是语句，不是语句的替代品）', () => {
		const statement = parsed({
			kind: 'if',
			condition: { kind: 'param', name: 'target_name' },
			then: [DELEGATE],
			else: [{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} }],
		});
		expect(statement.kind).toBe('if');
		if (statement.kind !== 'if') throw new Error('预期是分支');
		expect(statement.then).toEqual([DELEGATE]);
	});

	it('未知字段被拒（strict：形状不许自己长）', () => {
		expect(parse({ ...DELEGATE, primitiveRef: 'move_to_pose' }).success).toBe(false);
	});

	it('kind 混用被拒（delegate 不是 call 的别名）', () => {
		expect(parse({ ...DELEGATE, kind: 'call' }).success).toBe(false);
	});
});

describe('interfaceRef 是接口名，不是原语名', () => {
	it('接受真实的执行侧接口名', () => {
		for (const name of ['/manipulation/execute_pick', '/moveit_gateway/move_to_configuration', 'manipulation/execute_pick']) {
			expect(parsed({ ...DELEGATE, interfaceRef: name }).kind, name).toBe('delegate');
		}
	});

	it('空串被拒', () => {
		expect(parse({ ...DELEGATE, interfaceRef: '' }).success).toBe(false);
	});

	it('不是稳定引用的被拒（空白、双斜杠、结尾斜杠、非法首字符）', () => {
		for (const name of ['/manipulation/execute pick', '//manipulation/execute_pick', '/manipulation/execute_pick/', '-manipulation', '/', ' ', 'a\nb']) {
			expect(parse({ ...DELEGATE, interfaceRef: name }).success, JSON.stringify(name)).toBe(false);
		}
	});

	it('超过长度上限被拒（与稳定引用同口径）', () => {
		expect(parse({ ...DELEGATE, interfaceRef: `/${'a'.repeat(128)}` }).success).toBe(false);
	});

	it('口子只开在 delegate 上：call 的 primitiveRef 仍然不许带斜杠', () => {
		// 原语名是 `skill_library` 白名单里的词（`move_to_pose`），路径不是原语名。
		// 这条要是松了，`/manipulation/execute_pick` 就会被当成一个"原语"混进目录。
		expect(parse({ kind: 'call', primitiveRef: '/manipulation/execute_pick', arguments: {} }).success).toBe(false);
	});

	it('interfaceReferenceSchema 与 stableReferenceSchema 只差一个首斜杠与分段斜杠', () => {
		expect(interfaceReferenceSchema.safeParse('/manipulation/execute_pick').success).toBe(true);
		expect(interfaceReferenceSchema.safeParse('manipulation/execute_pick').success).toBe(true);
		expect(interfaceReferenceSchema.safeParse('move_to_pose').success).toBe(true);
		expect(interfaceReferenceSchema.safeParse('/').success).toBe(false);
	});
});

describe('delegate 的 arguments 与 call 同一套解析', () => {
	it('{kind:param} 能解析，且名字必须是标识符', () => {
		expect(parsed({ ...DELEGATE, arguments: { target_name: { kind: 'param', name: 'target_name' } } })).toEqual(DELEGATE);
		expect(parse({ ...DELEGATE, arguments: { target_name: { kind: 'param', name: '1target' } } }).success).toBe(false);
	});

	it('实参里的表达式照常下钻（嵌套原语调用也认）', () => {
		const statement = parsed({
			...DELEGATE,
			arguments: {
				target_name: { kind: 'call', primitiveRef: 'read_status', arguments: {} },
				pick_count: {
					kind: 'binary',
					operator: 'add',
					left: { kind: 'literal', value: 1 },
					right: { kind: 'param', name: 'target_name' },
				},
			},
		});
		expect(statement.kind).toBe('delegate');
		if (statement.kind !== 'delegate') throw new Error('预期是委托');
		expect(Object.keys(statement.arguments)).toEqual(['target_name', 'pick_count']);
	});
});

describe('原有三种语句一条没少', () => {
	it('call / set / if 仍然解析得出', () => {
		expect(parsed({ kind: 'call', primitiveRef: 'open_gripper', arguments: {} }).kind).toBe('call');
		expect(parsed({ kind: 'set', target: 'pose', value: { kind: 'literal', value: 1 } }).kind).toBe('set');
		expect(
			parsed({ kind: 'if', condition: { kind: 'unary', operator: 'not', value: { kind: 'literal', value: false } }, then: [{ kind: 'call', primitiveRef: 'open_gripper', arguments: {} }] })
				.kind,
		).toBe('if');
	});
});

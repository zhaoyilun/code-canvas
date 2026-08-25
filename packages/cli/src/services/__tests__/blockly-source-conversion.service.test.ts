import { parseBlocklyDataPayload } from '@n8n/blockly-data-transform';
import type {
	ModuleScaffoldRequestV1,
	OperationModuleTemplateV1,
} from '@n8n/dual-canvas-operation-sdk';

import { BlocklySourceConversionService } from '@/services/blockly-source-conversion.service';

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }));

vi.mock('openai', () => ({
	default: class OpenAI {
		chat = { completions: { create: createCompletion } };
	},
}));

const numericSource = `function transform(input) {
	const output = {};
	output.total = (input?.price ?? null) * (input?.quantity ?? null) + 2;
	return output;
}`;

const clampSource = `function transform(input) {
	const output = {};
	output.score = clampScore(input?.score ?? null, 0, 100);
	return output;
}`;

describe('BlocklySourceConversionService', () => {
	const service = new BlocklySourceConversionService();

	beforeEach(() => {
		createCompletion.mockReset();
		vi.stubEnv('DEEPSEEK_API_KEY', 'demo-key');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('converts supported source directly and reports a missing operation before generation', async () => {
		const ready = await service.convert({
			source: numericSource,
			currentBlocklyPayload: '',
			generateMissingOperation: false,
		});
		expect(ready.status).toBe('ready');
		if (ready.status !== 'ready') throw new Error('expected ready response');
		expect(parseBlocklyDataPayload(ready.blocklyPayload)).toMatchObject({ ok: true });
		expect(ready.workflowFragment.nodes).toHaveLength(2);

		const missing = await service.convert({
			source: clampSource,
			currentBlocklyPayload: '',
			generateMissingOperation: false,
		});
		expect(missing).toEqual({
			status: 'missing-operation',
			qualifiedName: 'clampScore',
			arity: 3,
			message: '缺少函数模块 clampScore/3',
		});
		expect(createCompletion).not.toHaveBeenCalled();
	});

	it('generates, admits, catalogs, and re-imports one missing operation', async () => {
		createCompletion.mockImplementation(async (request: { messages: PromptMessage[] }) => {
			const userMessage = request.messages.find(({ role }) => role === 'user');
			if (typeof userMessage?.content !== 'string') throw new Error('missing model prompt');
			const prompt = JSON.parse(userMessage.content) as ModelPrompt;
			return {
				choices: [{ message: { content: JSON.stringify(clampDraft(prompt)) } }],
			};
		});

		const result = await service.convert({
			source: clampSource,
			currentBlocklyPayload: '',
			generateMissingOperation: true,
			teacherIntent: '把分数限制在闭区间内，空值保持为空',
		});

		expect(result.status).toBe('ready');
		if (result.status !== 'ready') throw new Error('expected ready response');
		const parsed = parseBlocklyDataPayload(result.blocklyPayload);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.payload.operationCatalog.modules).toHaveLength(1);
		expect(parsed.payload.operationCatalog.modules[0]).toMatchObject({
			qualifiedName: 'clampScore',
			arity: 3,
			implementationRef: expect.stringMatching(/^implementation-/),
		});
		expect(createCompletion).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'deepseek-v4-flash',
				response_format: { type: 'json_object' },
			}),
		);
	});
});

type PromptMessage = { role: string; content: string | null };

type ModelPrompt = {
	scaffoldRequest: ModuleScaffoldRequestV1;
	moduleTemplate: OperationModuleTemplateV1;
};

function clampDraft({ scaffoldRequest, moduleTemplate }: ModelPrompt) {
	const [value, minimum, maximum] = moduleTemplate.parameters;
	if (!value || !minimum || !maximum) throw new Error('expected three parameter slots');
	const parameter = (parameterRef: string) => ({ kind: 'parameter' as const, parameterRef });
	const literal = (literalValue: number | null) => ({
		kind: 'literal' as const,
		value: literalValue,
	});
	const compare = (
		operator: 'eq' | 'lt' | 'gt',
		left: ReturnType<typeof parameter>,
		right: ReturnType<typeof parameter> | ReturnType<typeof literal>,
	) => ({ kind: 'binary' as const, operator, left, right });
	const conditional = (condition: object, whenTrue: object, whenFalse: object) => ({
		kind: 'conditional' as const,
		condition,
		whenTrue,
		whenFalse,
	});

	return {
		apiVersion: 1,
		requestRef: scaffoldRequest.requestRef,
		operationRef: moduleTemplate.identity.operationRef,
		implementationRef: null,
		qualifiedName: scaffoldRequest.qualifiedName,
		arity: scaffoldRequest.arity,
		version: moduleTemplate.identity.version,
		behaviorSummary: 'Return null for null input, otherwise clamp a number to inclusive bounds.',
		execution: 'synchronous',
		determinism: 'deterministic',
		effects: 'none',
		dataFlow: 'json-to-json',
		parameters: [
			{ parameterRef: value.parameterRef, name: 'value', type: 'number', nullPolicy: 'allow' },
			{
				parameterRef: minimum.parameterRef,
				name: 'minimum',
				type: 'number',
				nullPolicy: 'reject',
			},
			{
				parameterRef: maximum.parameterRef,
				name: 'maximum',
				type: 'number',
				nullPolicy: 'reject',
			},
		],
		output: { type: 'number', nullPolicy: 'allow' },
		expression: conditional(
			compare('eq', parameter(value.parameterRef), literal(null)),
			literal(null),
			conditional(
				compare('lt', parameter(value.parameterRef), parameter(minimum.parameterRef)),
				parameter(minimum.parameterRef),
				conditional(
					compare('gt', parameter(value.parameterRef), parameter(maximum.parameterRef)),
					parameter(maximum.parameterRef),
					parameter(value.parameterRef),
				),
			),
		),
		testVectors: [
			{ name: 'below minimum', arguments: [-1, 0, 100], expected: 0 },
			{ name: 'inside range', arguments: [42, 0, 100], expected: 42 },
			{ name: 'above maximum', arguments: [125, 0, 100], expected: 100 },
			{ name: 'null input', arguments: [null, 0, 100], expected: null },
		],
	};
}

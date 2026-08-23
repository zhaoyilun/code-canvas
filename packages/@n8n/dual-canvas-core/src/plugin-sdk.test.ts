import { describe, expect, it } from 'vitest';

import { resultError } from './diagnostics';
import {
	defineDualCanvasPlugin,
	dualCanvasPluginManifestV1Schema,
	canvasArtifactV1Schema,
	planArtifactV1Schema,
	pluginGenerationContextV1Schema,
	resolveWorkflowVisualProgrammingProfileV1,
	validatePluginBindings,
	workflowVisualProgrammingProfileV1Schema,
} from './plugin-sdk';

const unavailable = () =>
	resultError({
		apiVersion: 1,
		code: 'FIXTURE_UNAVAILABLE',
		severity: 'error',
		message: 'This fixture does not produce an artifact',
	});

const plugin = defineDualCanvasPlugin({
	manifest: {
		apiVersion: 1,
		id: 'sample.publisher',
		version: '0.1.0',
		displayName: 'Sample publisher',
		n8nPackage: 'n8n-nodes-sample',
		editorProfile: 'capability-plan',
		requiredNodeTypeBindings: ['publish', 'status'],
		workbenchProfile: {
			profileRef: 'sample.teaching',
			displayName: 'Sample teaching',
			canvasAdapters: [
				{
					adapterRef: 'sample.steps',
					displayName: 'Sample steps',
					payloadMediaType: 'application/vnd.sample.steps+json',
					canvasKind: 'extension',
				},
			],
			stages: [
				{
					stageRef: 'prepare',
					label: 'Prepare',
					nodeRoles: ['publish'],
				},
			],
			capabilities: [
				{
					capabilityRef: 'publishing',
					label: 'Publishing',
					nodeRoles: ['publish'],
				},
			],
		},
	},
	normalizeCatalog: unavailable,
	generatePlan: unavailable,
	buildWorkflowFragment: unavailable,
	validateWorkflow: () => [],
});

describe('declarative plugin SDK', () => {
	it('normalizes and freezes the public manifest shape', () => {
		expect(plugin.manifest).toMatchObject({
			apiVersion: 1,
			id: 'sample.publisher',
			editorProfile: 'capability-plan',
			workbenchProfile: { profileRef: 'sample.teaching' },
		});
		expect(dualCanvasPluginManifestV1Schema.safeParse(plugin.manifest).success).toBe(true);
	});

	it('checks package identity and required binding references', () => {
		expect(
			validatePluginBindings(plugin, {
				apiVersion: 1,
				packageName: 'n8n-nodes-sample',
				nodeTypes: {
					publish: 'n8n-nodes-sample.publish',
					status: 'n8n-nodes-sample.status',
				},
			}),
		).toEqual([]);
		expect(
			validatePluginBindings(plugin, {
				apiVersion: 1,
				packageName: 'n8n-nodes-other',
				nodeTypes: { publish: 'n8n-nodes-other.publish' },
			}),
		).toEqual([
			expect.objectContaining({ code: 'NODE_TYPE_BINDINGS_PACKAGE_MISMATCH' }),
			expect.objectContaining({ code: 'NODE_TYPE_BINDING_MISSING', ref: 'status' }),
		]);
	});

	it('keeps the editor adapter and workbench presentation identifiers independent', () => {
		expect(
			dualCanvasPluginManifestV1Schema.safeParse({
				...plugin.manifest,
				editorProfile: 'capability-plan',
				workbenchProfile: {
					...plugin.manifest.workbenchProfile,
					profileRef: 'other.presentation',
				},
			}).success,
		).toBe(true);
		expect(
			dualCanvasPluginManifestV1Schema.safeParse({
				...plugin.manifest,
				profile: plugin.manifest.workbenchProfile,
			}).success,
		).toBe(false);
	});

	it('resolves the portable descriptor into the shared workflow metadata schema', () => {
		const result = resolveWorkflowVisualProgrammingProfileV1(plugin.manifest.workbenchProfile, {
			apiVersion: 1,
			packageName: 'n8n-nodes-sample',
			nodeTypes: {
				publish: 'installed.sample.publisher',
				status: 'installed.sample.status',
			},
		});
		expect(result).toEqual({
			ok: true,
			value: {
				schemaVersion: 1,
				profileId: 'sample.teaching',
				displayName: 'Sample teaching',
				stages: [
					{
						id: 'prepare',
						label: 'Prepare',
						nodeTypes: ['installed.sample.publisher'],
					},
				],
				capabilities: [
					{
						id: 'publishing',
						label: 'Publishing',
						nodeTypes: ['installed.sample.publisher'],
					},
				],
			},
		});
		if (result.ok) {
			expect(workflowVisualProgrammingProfileV1Schema.safeParse(result.value).success).toBe(true);
		}
		const missing = resolveWorkflowVisualProgrammingProfileV1(plugin.manifest.workbenchProfile, {
			apiVersion: 1,
			packageName: 'n8n-nodes-sample',
			nodeTypes: { status: 'installed.sample.status' },
		});
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			'WORKBENCH_NODE_TYPE_BINDING_MISSING',
		);
	});

	it('returns diagnostics for repeated roles and role aliases instead of throwing', () => {
		const repeatedRoleProfile = {
			...plugin.manifest.workbenchProfile,
			stages: [
				{
					stageRef: 'prepare',
					label: 'Prepare',
					nodeRoles: ['publish', 'publish'],
				},
			],
		};
		const bindings = {
			apiVersion: 1,
			packageName: 'n8n-nodes-sample',
			nodeTypes: {
				publish: 'installed.sample.shared',
				status: 'installed.sample.shared',
			},
		};
		const repeated = resolveWorkflowVisualProgrammingProfileV1(repeatedRoleProfile, bindings);
		expect(repeated.ok).toBe(false);
		if (repeated.ok) return;
		expect(repeated.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			'WORKBENCH_NODE_ROLE_DUPLICATE',
		);

		const aliasedRoleProfile = {
			...plugin.manifest.workbenchProfile,
			stages: [
				{
					stageRef: 'prepare',
					label: 'Prepare',
					nodeRoles: ['publish', 'status'],
				},
			],
		};
		const aliased = resolveWorkflowVisualProgrammingProfileV1(aliasedRoleProfile, bindings);
		expect(aliased.ok).toBe(false);
		if (aliased.ok) return;
		expect(aliased.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			'WORKBENCH_NODE_TYPE_DUPLICATE',
		);

		const aliasedPlugin = {
			...plugin,
			manifest: {
				...plugin.manifest,
				workbenchProfile: aliasedRoleProfile as NonNullable<
					typeof plugin.manifest.workbenchProfile
				>,
			},
		};
		expect(validatePluginBindings(aliasedPlugin, bindings)).toEqual([
			expect.objectContaining({ code: 'WORKBENCH_NODE_TYPE_DUPLICATE', ref: 'status' }),
		]);
	});

	it('validates block references against inventory and mapping identities across canvases', () => {
		const mapping = {
			apiVersion: 1,
			mappingRef: 'mapping.shared',
			semanticRef: 'step.shared',
			artifact: { kind: 'canvasBlock', ref: 'block.first' },
		} as const;
		const firstCanvas = {
			apiVersion: 1,
			canvasRef: 'canvas.first',
			adapterRef: 'adapter.logic',
			payloadMediaType: 'application/json',
			payload: '{}',
			blockRefs: ['block.first'],
			sourceMap: [mapping],
		} as const;
		expect(canvasArtifactV1Schema.safeParse(firstCanvas).success).toBe(true);
		expect(
			canvasArtifactV1Schema.safeParse({
				...firstCanvas,
				sourceMap: [
					{ ...mapping, artifact: { kind: 'canvasBlock', ref: 'block.not-in-inventory' } },
				],
			}).success,
		).toBe(false);

		const conflictingCanvas = {
			...firstCanvas,
			canvasRef: 'canvas.second',
			blockRefs: ['block.second'],
			sourceMap: [
				{
					...mapping,
					semanticRef: 'step.second',
					artifact: { kind: 'canvasBlock', ref: 'block.second' },
				},
			],
		};
		expect(
			planArtifactV1Schema.safeParse({
				apiVersion: 1,
				artifactRef: 'artifact.sample',
				plan: {
					apiVersion: 1,
					planRef: 'plan.sample',
					catalogRef: 'catalog.sample',
					catalogRevisionRef: 'revision.1',
					steps: [
						{
							stepRef: 'step.shared',
							capabilityRef: 'sample.run',
							arguments: {},
							dependsOn: [],
						},
					],
				},
				canvases: [firstCanvas, conflictingCanvas],
				sourceMap: [],
			}).success,
		).toBe(false);
	});

	it('names the generation selection as a workbench profile', () => {
		const context = {
			apiVersion: 1,
			documentRef: 'document.1',
			revisionRef: 'revision.1',
			catalog: {
				apiVersion: 1,
				catalogRef: 'sample.catalog',
				revisionRef: 'revision.1',
				capabilities: [
					{
						capabilityRef: 'sample.publish',
						displayName: 'Publish',
						inputs: [],
						outputs: [],
					},
				],
			},
			workbenchProfileRef: 'sample.teaching',
		};
		expect(pluginGenerationContextV1Schema.safeParse(context).success).toBe(true);
		expect(
			pluginGenerationContextV1Schema.safeParse({
				...context,
				workbenchProfileRef: undefined,
				profileRef: 'sample.teaching',
			}).success,
		).toBe(false);
	});
});

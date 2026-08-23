import { z } from 'zod';

import {
	capabilityCatalogV1Schema,
	executionPlanV1Schema,
	nodeTypeBindingsV1Schema,
	type CapabilityCatalogV1,
	type NodeTypeBindingsV1,
	type WorkflowFragmentV1,
} from './data-plane';
import { resultError, resultOk, type DiagnosticV1, type ResultV1 } from './diagnostics';
import { sourceMapEntryV1Schema, type TraceEntryV1 } from './mapping';
import {
	jsonObjectSchema,
	installedNodeTypeSchema,
	packageNameSchema,
	stableReferenceSchema,
	versionStringSchema,
} from './primitives';

export const canvasAdapterDescriptorV1Schema = z
	.object({
		adapterRef: stableReferenceSchema,
		displayName: z.string().trim().min(1).max(128),
		payloadMediaType: z.string().trim().min(1).max(128),
		canvasKind: z.enum(['logic', 'extension']),
		toolboxProfile: stableReferenceSchema.optional(),
	})
	.strict();

export const workbenchStageDescriptorV1Schema = z
	.object({
		stageRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(128),
		description: z.string().trim().min(1).max(1000).optional(),
		nodeRoles: z.array(stableReferenceSchema).min(1).max(128),
	})
	.strict();

export const workbenchCapabilityDescriptorV1Schema = z
	.object({
		capabilityRef: stableReferenceSchema,
		label: z.string().trim().min(1).max(128),
		nodeRoles: z.array(stableReferenceSchema).min(1).max(128),
	})
	.strict();

export const workflowVisualProgrammingStageV1Schema = z
	.object({
		id: stableReferenceSchema,
		label: z.string().trim().min(1).max(128),
		nodeTypes: z.array(installedNodeTypeSchema).min(1).max(128),
	})
	.strict()
	.superRefine((stage, context) => {
		addDuplicateRefIssues(stage.nodeTypes, context, 'nodeTypes', 'nodeType');
	});

export const workflowVisualProgrammingCapabilityV1Schema = z
	.object({
		id: stableReferenceSchema,
		label: z.string().trim().min(1).max(128),
		nodeTypes: z.array(installedNodeTypeSchema).min(1).max(128),
	})
	.strict()
	.superRefine((capability, context) => {
		addDuplicateRefIssues(capability.nodeTypes, context, 'nodeTypes', 'nodeType');
	});

/** The single serialized schema consumed from workflow.meta.visualProgramming. */
export const workflowVisualProgrammingProfileV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		profileId: stableReferenceSchema,
		displayName: z.string().trim().min(1).max(128),
		brand: z.string().trim().min(1).max(128).optional(),
		stages: z.array(workflowVisualProgrammingStageV1Schema).min(1).max(64),
		capabilities: z.array(workflowVisualProgrammingCapabilityV1Schema).max(128).optional(),
	})
	.strict()
	.superRefine((profile, context) => {
		addDuplicateRefIssues(
			profile.stages.map((stage) => stage.id),
			context,
			'stages',
			'id',
		);
		addDuplicateRefIssues(
			(profile.capabilities ?? []).map((capability) => capability.id),
			context,
			'capabilities',
			'id',
		);
	});

export const workbenchProfileDescriptorV1Schema = z
	.object({
		profileRef: stableReferenceSchema,
		displayName: z.string().trim().min(1).max(128),
		brand: z.string().trim().min(1).max(128).optional(),
		canvasAdapters: z.array(canvasAdapterDescriptorV1Schema).max(32),
		stages: z.array(workbenchStageDescriptorV1Schema).min(1).max(64),
		capabilities: z.array(workbenchCapabilityDescriptorV1Schema).max(128).optional(),
	})
	.strict()
	.superRefine((profile, context) => {
		addDuplicateRefIssues(
			profile.canvasAdapters.map((adapter) => adapter.adapterRef),
			context,
			'canvasAdapters',
			'adapterRef',
		);
		addDuplicateRefIssues(
			profile.stages.map((stage) => stage.stageRef),
			context,
			'stages',
			'stageRef',
		);
		addDuplicateRefIssues(
			(profile.capabilities ?? []).map((capability) => capability.capabilityRef),
			context,
			'capabilities',
			'capabilityRef',
		);
	});

export const dualCanvasPluginManifestV1Schema = z
	.object({
		apiVersion: z.literal(1),
		id: stableReferenceSchema,
		version: versionStringSchema.optional(),
		displayName: z.string().trim().min(1).max(128).optional(),
		n8nPackage: packageNameSchema,
		editorProfile: stableReferenceSchema,
		requiredNodeTypeBindings: z.array(stableReferenceSchema).max(256).optional(),
		workbenchProfile: workbenchProfileDescriptorV1Schema.optional(),
	})
	.strict()
	.superRefine((manifest, context) => {
		addDuplicateRefIssues(
			manifest.requiredNodeTypeBindings ?? [],
			context,
			'requiredNodeTypeBindings',
			'bindingRef',
		);
	});

export const canvasArtifactV1Schema = z
	.object({
		apiVersion: z.literal(1),
		canvasRef: stableReferenceSchema,
		adapterRef: stableReferenceSchema,
		ownerNodeRef: stableReferenceSchema.optional(),
		payloadMediaType: z.string().trim().min(1).max(128),
		payload: z.string().min(1).max(1_048_576),
		preview: z.string().max(262_144).optional(),
		blockRefs: z.array(z.string().trim().min(1).max(256)).max(20_000),
		sourceMap: z.array(sourceMapEntryV1Schema).max(4000),
	})
	.strict()
	.superRefine((canvas, context) => {
		addDuplicateRefIssues(canvas.blockRefs, context, 'blockRefs', 'blockRef');
		addDuplicateRefIssues(
			canvas.sourceMap.map((entry) => entry.mappingRef),
			context,
			'sourceMap',
			'mappingRef',
		);
		const blockRefs = new Set(canvas.blockRefs);
		for (const [index, entry] of canvas.sourceMap.entries()) {
			if (entry.artifact.kind === 'canvasBlock' && !blockRefs.has(entry.artifact.ref)) {
				context.addIssue({
					code: 'custom',
					path: ['sourceMap', index, 'artifact', 'ref'],
					message: `unknown canvasBlock artifact "${entry.artifact.ref}"`,
				});
			}
		}
	});

export const planArtifactV1Schema = z
	.object({
		apiVersion: z.literal(1),
		artifactRef: stableReferenceSchema,
		plan: executionPlanV1Schema,
		canvases: z.array(canvasArtifactV1Schema).max(256),
		sourceMap: z.array(sourceMapEntryV1Schema).max(8000),
		metadata: jsonObjectSchema.optional(),
	})
	.strict()
	.superRefine((artifact, context) => {
		addDuplicateRefIssues(
			artifact.canvases.map((canvas) => canvas.canvasRef),
			context,
			'canvases',
			'canvasRef',
		);
		addDuplicateRefIssues(
			artifact.sourceMap.map((entry) => entry.mappingRef),
			context,
			'sourceMap',
			'mappingRef',
		);
		addTreeMappingRefIssues(artifact.sourceMap, artifact.canvases, context);
		const planStepRefs = new Set(artifact.plan.steps.map((step) => step.stepRef));
		const canvasRefs = new Set(artifact.canvases.map((canvas) => canvas.canvasRef));
		const canvasBlockRefs = new Set(artifact.canvases.flatMap((canvas) => canvas.blockRefs));
		for (const [index, entry] of artifact.sourceMap.entries()) {
			const known =
				(entry.artifact.kind === 'planStep' && planStepRefs.has(entry.artifact.ref)) ||
				(entry.artifact.kind === 'canvas' && canvasRefs.has(entry.artifact.ref)) ||
				(entry.artifact.kind === 'canvasBlock' && canvasBlockRefs.has(entry.artifact.ref)) ||
				entry.artifact.kind === 'other';
			if (!known) {
				context.addIssue({
					code: 'custom',
					path: ['sourceMap', index, 'artifact', 'ref'],
					message: `unknown ${entry.artifact.kind} artifact "${entry.artifact.ref}"`,
				});
			}
		}
	});

export const pluginGenerationContextV1Schema = z
	.object({
		apiVersion: z.literal(1),
		documentRef: stableReferenceSchema,
		revisionRef: stableReferenceSchema,
		catalog: capabilityCatalogV1Schema,
		workbenchProfileRef: stableReferenceSchema.optional(),
		metadata: jsonObjectSchema.optional(),
	})
	.strict();

export type CanvasAdapterDescriptorV1 = z.infer<typeof canvasAdapterDescriptorV1Schema>;
export type WorkbenchProfileDescriptorV1 = z.infer<typeof workbenchProfileDescriptorV1Schema>;
export type WorkflowVisualProgrammingProfileV1 = z.infer<
	typeof workflowVisualProgrammingProfileV1Schema
>;
export type DualCanvasPluginManifestV1 = z.infer<typeof dualCanvasPluginManifestV1Schema>;
export type CanvasArtifactV1 = z.infer<typeof canvasArtifactV1Schema>;
export type PlanArtifactV1 = z.infer<typeof planArtifactV1Schema>;
export type PluginGenerationContextV1 = z.infer<typeof pluginGenerationContextV1Schema>;

export interface DualCanvasPluginV1 {
	manifest: DualCanvasPluginManifestV1;
	normalizeCatalog(raw: unknown): ResultV1<CapabilityCatalogV1>;
	generatePlan(draft: unknown, context: PluginGenerationContextV1): ResultV1<PlanArtifactV1>;
	buildWorkflowFragment(
		artifact: PlanArtifactV1,
		bindings: NodeTypeBindingsV1,
	): ResultV1<WorkflowFragmentV1>;
	validateWorkflow(fragment: WorkflowFragmentV1): DiagnosticV1[];
	normalizeTrace?(
		raw: unknown,
		context: { runRef: string; artifact: PlanArtifactV1 },
	): ResultV1<TraceEntryV1[]>;
}

export function defineDualCanvasPlugin(plugin: DualCanvasPluginV1): DualCanvasPluginV1 {
	return {
		...plugin,
		manifest: dualCanvasPluginManifestV1Schema.parse(plugin.manifest),
	};
}

export function validatePluginBindings(
	plugin: DualCanvasPluginV1,
	bindingsInput: unknown,
): DiagnosticV1[] {
	const bindings = nodeTypeBindingsV1Schema.safeParse(bindingsInput);
	if (!bindings.success) {
		return bindings.error.issues.map((issue) => ({
			apiVersion: 1,
			code: 'NODE_TYPE_BINDINGS_INVALID',
			severity: 'error',
			message: issue.message,
			...(issue.path.length === 0 ? {} : { path: issue.path.join('.') }),
		}));
	}

	const diagnostics: DiagnosticV1[] = [];
	if (bindings.data.packageName !== plugin.manifest.n8nPackage) {
		diagnostics.push({
			apiVersion: 1,
			code: 'NODE_TYPE_BINDINGS_PACKAGE_MISMATCH',
			severity: 'error',
			message: 'node type bindings belong to a different package',
			path: 'packageName',
		});
	}
	for (const bindingRef of plugin.manifest.requiredNodeTypeBindings ?? []) {
		if (bindings.data.nodeTypes[bindingRef] === undefined) {
			diagnostics.push({
				apiVersion: 1,
				code: 'NODE_TYPE_BINDING_MISSING',
				severity: 'error',
				message: `required node type binding "${bindingRef}" is missing`,
				ref: bindingRef,
				path: `nodeTypes.${bindingRef}`,
			});
		}
	}
	if (plugin.manifest.workbenchProfile !== undefined) {
		for (const diagnostic of validateWorkbenchProfileBindings(
			plugin.manifest.workbenchProfile,
			bindings.data,
		)) {
			diagnostics.push(diagnostic);
		}
	}
	return diagnostics;
}

/** Resolve portable binding roles into the only workflow metadata profile shape. */
export function resolveWorkflowVisualProgrammingProfileV1(
	profileInput: unknown,
	bindingsInput: unknown,
): ResultV1<WorkflowVisualProgrammingProfileV1> {
	const profile = workbenchProfileDescriptorV1Schema.safeParse(profileInput);
	if (!profile.success) {
		return resultError(
			...profile.error.issues.map((issue) => ({
				apiVersion: 1 as const,
				code: 'WORKBENCH_PROFILE_INVALID',
				severity: 'error' as const,
				message: issue.message,
				...(issue.path.length === 0 ? {} : { path: issue.path.join('.') }),
			})),
		);
	}
	const bindings = nodeTypeBindingsV1Schema.safeParse(bindingsInput);
	if (!bindings.success) {
		return resultError(
			...bindings.error.issues.map((issue) => ({
				apiVersion: 1 as const,
				code: 'NODE_TYPE_BINDINGS_INVALID',
				severity: 'error' as const,
				message: issue.message,
				...(issue.path.length === 0 ? {} : { path: issue.path.join('.') }),
			})),
		);
	}
	const bindingDiagnostics = validateWorkbenchProfileBindings(profile.data, bindings.data);
	if (bindingDiagnostics.length > 0) return resultError(...bindingDiagnostics);

	const resolveRoles = (nodeRoles: string[]) =>
		nodeRoles.map((nodeRole) => bindings.data.nodeTypes[nodeRole]);
	const resolved = workflowVisualProgrammingProfileV1Schema.safeParse({
		schemaVersion: 1,
		profileId: profile.data.profileRef,
		displayName: profile.data.displayName,
		...(profile.data.brand === undefined ? {} : { brand: profile.data.brand }),
		stages: profile.data.stages.map((stage) => ({
			id: stage.stageRef,
			label: stage.label,
			nodeTypes: resolveRoles(stage.nodeRoles),
		})),
		...(profile.data.capabilities === undefined
			? {}
			: {
					capabilities: profile.data.capabilities.map((capability) => ({
						id: capability.capabilityRef,
						label: capability.label,
						nodeTypes: resolveRoles(capability.nodeRoles),
					})),
				}),
	});
	if (!resolved.success) {
		return resultError(
			...resolved.error.issues.map((issue) => ({
				apiVersion: 1 as const,
				code: 'WORKBENCH_PROFILE_RESOLUTION_INVALID',
				severity: 'error' as const,
				message: issue.message,
				...(issue.path.length === 0 ? {} : { path: issue.path.join('.') }),
			})),
		);
	}
	return resultOk(resolved.data);
}

function validateWorkbenchProfileBindings(
	profile: WorkbenchProfileDescriptorV1,
	bindings: NodeTypeBindingsV1,
): DiagnosticV1[] {
	const diagnostics: DiagnosticV1[] = [];
	const groups = [
		...profile.stages.map((stage, index) => ({
			path: `stages.${index}.nodeRoles`,
			roles: stage.nodeRoles,
		})),
		...(profile.capabilities ?? []).map((capability, index) => ({
			path: `capabilities.${index}.nodeRoles`,
			roles: capability.nodeRoles,
		})),
	];
	for (const group of groups) {
		const seenRoles = new Set<string>();
		const nodeTypeOwners = new Map<string, { role: string; roleIndex: number }>();
		for (const [roleIndex, role] of group.roles.entries()) {
			if (seenRoles.has(role)) {
				diagnostics.push({
					apiVersion: 1,
					code: 'WORKBENCH_NODE_ROLE_DUPLICATE',
					severity: 'error',
					message: `workbench node role "${role}" is repeated in the same group`,
					ref: role,
					path: `${group.path}.${roleIndex}`,
				});
				continue;
			}
			seenRoles.add(role);
			const nodeType = bindings.nodeTypes[role];
			if (nodeType === undefined) {
				diagnostics.push({
					apiVersion: 1,
					code: 'WORKBENCH_NODE_TYPE_BINDING_MISSING',
					severity: 'error',
					message: `workbench node role "${role}" has no installed node type binding`,
					ref: role,
					path: `${group.path}.${roleIndex}`,
				});
				continue;
			}
			const existing = nodeTypeOwners.get(nodeType);
			if (existing !== undefined) {
				diagnostics.push({
					apiVersion: 1,
					code: 'WORKBENCH_NODE_TYPE_DUPLICATE',
					severity: 'error',
					message: `workbench node roles "${existing.role}" and "${role}" resolve to the same installed node type "${nodeType}"`,
					ref: role,
					path: `${group.path}.${roleIndex}`,
					details: { firstRole: existing.role, firstRoleIndex: existing.roleIndex, nodeType },
				});
				continue;
			}
			nodeTypeOwners.set(nodeType, { role, roleIndex });
		}
	}
	return diagnostics;
}

function addTreeMappingRefIssues(
	rootEntries: Array<z.infer<typeof sourceMapEntryV1Schema>>,
	canvases: CanvasArtifactV1[],
	context: z.RefinementCtx,
): void {
	const seen = new Map<
		string,
		{ entry: z.infer<typeof sourceMapEntryV1Schema>; path: Array<string | number> }
	>();
	const groups = [
		{ entries: rootEntries, path: ['sourceMap'] as Array<string | number> },
		...canvases.map((canvas, index) => ({
			entries: canvas.sourceMap,
			path: ['canvases', index, 'sourceMap'] as Array<string | number>,
		})),
	];
	for (const group of groups) {
		for (const [index, entry] of group.entries.entries()) {
			const existing = seen.get(entry.mappingRef);
			if (existing !== undefined && JSON.stringify(existing.entry) !== JSON.stringify(entry)) {
				context.addIssue({
					code: 'custom',
					path: [...group.path, index, 'mappingRef'],
					message: `mappingRef "${entry.mappingRef}" conflicts with ${formatIssuePath(existing.path)}`,
				});
				continue;
			}
			seen.set(entry.mappingRef, { entry, path: [...group.path, index, 'mappingRef'] });
		}
	}
}

function formatIssuePath(path: Array<string | number>): string {
	return path.map(String).join('.');
}

function addDuplicateRefIssues(
	refs: string[],
	context: z.RefinementCtx,
	collection: string,
	field: string,
): void {
	const seen = new Set<string>();
	for (const [index, ref] of refs.entries()) {
		if (seen.has(ref)) {
			context.addIssue({
				code: 'custom',
				path: [collection, index],
				message: `duplicate ${field} "${ref}"`,
			});
		}
		seen.add(ref);
	}
}

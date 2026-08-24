import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	createClampBlockDescriptor,
	createClampImportRequest,
	createClampModuleDraft,
	createClampModuleSpec,
	createClampOperationCatalog,
	expectedClampOutput,
	finalizeClampModuleDraft,
	generateUnknownOperationArtifacts,
	getUnknownOperationBuildProblems,
	unknownOperationBuildRequirements,
	parseArguments,
} from './unknown-operation-runtime-acceptance.mjs';

test('check mode binds all five package outputs to production source and manifest inputs', () => {
	assert.equal(unknownOperationBuildRequirements.length, 5);
	for (const requirement of unknownOperationBuildRequirements) {
		assert.ok(requirement.inputs.some((path) => path.endsWith('package.json')));
		assert.ok(requirement.inputs.some((path) => path.endsWith('src')));
		assert.ok(requirement.freshnessMarker.endsWith('build.tsbuildinfo'));
		assert.match(requirement.command, /tsc -b tsconfig\.build\.json --force$/);
	}
	assert.deepEqual(getUnknownOperationBuildProblems(), []);
});

test('unknown operation closes discovery, admission, registry, dual-canvas, and VM gates', () => {
	const first = generateUnknownOperationArtifacts();
	const second = generateUnknownOperationArtifacts();
	assert.deepEqual(second, first);
	assert.equal(first.initialImportDiagnostic.ok, false);
	assert.equal(first.initialImportDiagnostic.diagnostics[0]?.code, 'OPERATION_MODULE_MISSING');
	assert.equal(first.operationCatalog.modules.length, 1);
	assert.equal(first.blockDescriptor.qualifiedName, 'clampScore');
	assert.equal(first.moduleDraft.implementationRef, null);
	assert.equal(first.blockDescriptor.implementationRef, first.moduleSpec.implementationRef);
	const operationCall = collectByKind(first.logic, 'operationCall')[0];
	assert.equal(operationCall?.implementationRef, first.moduleSpec.implementationRef);
	assert.match(JSON.stringify(first.workspace), new RegExp(first.moduleSpec.implementationRef));
	assert.equal(
		first.blocklyPayload.operationCatalog.modules[0]?.implementationRef,
		first.moduleSpec.implementationRef,
	);
	assert.match(
		JSON.stringify(first.blocklyPayload.workspace),
		new RegExp(first.moduleSpec.implementationRef),
	);
	assert.deepEqual(first.nodeVmEquivalence.sourceOutput, expectedClampOutput);
	assert.deepEqual(first.nodeVmEquivalence.generatedOutput, { json: expectedClampOutput });
});

test('generated spec remains bound to its discovery request', () => {
	const artifacts = generateUnknownOperationArtifacts();
	const draft = createClampModuleDraft(artifacts.scaffoldRequest);
	assert.equal(draft.implementationRef, null);
	const spec = createClampModuleSpec(artifacts.scaffoldRequest);
	assert.equal(spec.requestRef, artifacts.scaffoldRequest.requestRef);
	assert.equal(spec.qualifiedName, artifacts.scaffoldRequest.qualifiedName);
	assert.equal(spec.arity, artifacts.scaffoldRequest.arity);
	const request = createClampImportRequest(artifacts.source, artifacts.operationCatalog);
	assert.deepEqual(request.operationCatalog, artifacts.operationCatalog);
});

test('changed expression keeps logical identity but creates a new immutable implementation and block type', () => {
	const artifacts = generateUnknownOperationArtifacts();
	const changedDraft = structuredClone(artifacts.moduleDraft);
	changedDraft.expression = { kind: 'literal', value: 50 };
	changedDraft.testVectors = changedDraft.testVectors.map((vector) => ({
		...vector,
		expected: 50,
	}));
	const changedSpec = finalizeClampModuleDraft(changedDraft);
	const changedCatalog = createClampOperationCatalog(changedSpec);
	const changedDescriptor = createClampBlockDescriptor(changedSpec);

	assert.equal(changedSpec.operationRef, artifacts.moduleSpec.operationRef);
	assert.equal(changedSpec.qualifiedName, artifacts.moduleSpec.qualifiedName);
	assert.equal(changedSpec.arity, artifacts.moduleSpec.arity);
	assert.equal(changedSpec.version, artifacts.moduleSpec.version);
	assert.notEqual(changedSpec.implementationRef, artifacts.moduleSpec.implementationRef);
	assert.equal(changedCatalog.modules[0]?.implementationRef, changedSpec.implementationRef);
	assert.notEqual(changedDescriptor.blockType, artifacts.blockDescriptor.blockType);
});

test('CLI arguments keep check mode and isolated runtime directory explicit', () => {
	assert.deepEqual(parseArguments(['--check']), { checkOnly: true, runtimeDir: undefined });
	assert.deepEqual(parseArguments(['--runtime-dir=C:/temp/n8n-operation']), {
		checkOnly: false,
		runtimeDir: 'C:/temp/n8n-operation',
	});
	assert.throws(() => parseArguments(['--runtime-dir']));
	assert.throws(() => parseArguments(['--extra']));
});

function collectByKind(value, kind, matches = []) {
	if (Array.isArray(value)) {
		for (const entry of value) collectByKind(entry, kind, matches);
		return matches;
	}
	if (!value || typeof value !== 'object') return matches;
	if (value.kind === kind) matches.push(value);
	for (const child of Object.values(value)) collectByKind(child, kind, matches);
	return matches;
}

# Unknown operation discovery and scaffolding

## Purpose

The first dual-canvas importer supports a deliberately small, source-equivalent transformation
language. A real lesson will eventually call a pure helper that the repository does not yet know.
This slice makes that gap auditable without guessing what the helper does:

```text
static unknown call
  -> OPERATION_MODULE_MISSING
  -> ModuleScaffoldRequestV1 (AST evidence)
  -> OperationModuleTemplateV1 (fixed generation shell)
  -> AI or human completes decisions
  -> OperationModuleSpecV1 schema + test admission
```

It does not register or execute the generated operation in this slice.

## Example: `clamp`

```ts
function transform(input) {
	const output = {};
	output.low = clamp(-2, 0, 10);
	output.high = clamp(12, 0, 10);
	return output;
}
```

Both calls have the key `clamp/3`, so the importer emits one diagnostic. Its `details` value is a
complete `ModuleScaffoldRequestV1`. Each call has a deterministic `callRef`, exact `callText` and
source span, and three independently spanned arguments. Request and call references are scoped by
document, revision, and source, so a repeated import is stable while a new revision receives new
references. Numeric literals are recorded as evidence; the behavior of `clamp` is not inferred from
its name.

The request explicitly leaves these decisions to the generator and reviewer:

1. behavior;
2. effect classification;
3. parameter names;
4. input types;
5. null handling;
6. output type;
7. at least three test vectors.

`createOperationModuleTemplateV1(request)` deterministically produces parameter placeholders and a
fixed JSON envelope. The template states the target constraints—synchronous, deterministic,
side-effect-free JSON-to-JSON—and leaves semantic fields empty. If the observed source call actually
needs async work, network access, device access, or another side effect, it routes to a
capability/plugin instead of becoming an operation expression.

## Admission boundary

`OperationModuleSpecV1` is the completed module artifact, not the generated template. The strict
`OperationModuleAdmissionV1` envelope is the admission artifact: it binds the spec to its request by
request reference, qualified name, and arity. Its schemas:

- is strict at every object boundary;
- accepts only a bounded declarative expression tree, with no source code or runtime evaluation;
- performs iterative size/depth/cycle preflights at every recursive public schema entry before Zod
  parses untrusted JSON;
- validates every expression parameter reference against the declared parameters;
- requires the declared parameter count to equal the operation arity;
- caps expression depth at 16 and expression nodes at 128;
- requires three to 32 JSON input/output test vectors and validates vector arity;
- fixes execution to synchronous, deterministic, effect-free JSON-to-JSON behavior.

Schema validation proves shape and structural limits. The supplied test vectors are the semantic
acceptance evidence and must be run by the later registry slice before an operation is exposed to a
lesson.

## Deliberate completion boundary

This slice ends at discovery, deterministic scaffolding, and schema-level admission. The following
pieces are kept together for the next end-to-end slice:

- operation registry and duplicate/version policy;
- an `operationCall` expression in the shared visual IR;
- deterministic Blockly block definitions and toolbox registration;
- execution of admitted expressions and their test vectors;
- regeneration of both canvases with source mappings.

RoboFrame remains an independent plugin. Nothing in these contracts embeds a robot, device, or
competition capability.

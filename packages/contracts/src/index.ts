/**
 * Versioned contracts for CodeCanvas.
 *
 * Everything that crosses a boundary lives here: the phase-1 robot task protocol,
 * the workflow declaration, stable-id generation, and diagnostics.
 * See docs/spec.md §1.
 */
export * from './json';
export * from './sha256';
export * from './diagnostic';
export * from './stable-ids';
export * from './task-protocol';
export * from './skill-plan';
export * from './workflow';
export * from './capability';
export * from './device-facts';
export * from './teaching-spec';
export * from './step-gate';

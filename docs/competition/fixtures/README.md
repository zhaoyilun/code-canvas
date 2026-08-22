# Competition Designer v2 fixtures

- `design-draft-v2.json`: strict AI semantic draft v2;
- `workflow-v2.json`: importable 15-node n8n workflow;
- `artifact-summary-v2.json`: generated Blockly Logic workspace/payload, RobotTaskPlan and trace map.

Regenerate after building `@n8n/blockly-data-transform`, `@n8n/blockly-robot-skills` and
`@n8n/competition-designer`:

```bash
node scripts/competition/generate-software-slice-2-demo.mjs
```

The workflow contains credential placeholders. Set the target instance's RoboFrame credential
reference after importing it into n8n.

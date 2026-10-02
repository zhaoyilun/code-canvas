/**
 * 示例任务：界面在没有输入时的默认内容，也用作三个视图的手工验证素材。
 * 形状与 docs/spec.md §1.1 一致。
 */
export const SAMPLE_TASK_JSON = `{
  "schema_version": "1.0",
  "task_id": "task-demo-001",
  "description": "前进，遇障停止后转向",
  "steps": [
    { "id": "s1", "action": "move", "linear": 0.2, "angular": 0.0, "duration": 5.0 },
    { "id": "s2", "action": "stop_if_obstacle", "sensors": ["/scan0"], "distance": 0.5 },
    { "id": "s3", "action": "turn", "angular": 0.8, "duration": 2.0 },
    { "id": "s4", "action": "stop" }
  ],
  "limits": {
    "max_linear": 0.3,
    "max_angular": 1.2,
    "max_duration": 30.0,
    "require_confirmation": true
  }
}
`;

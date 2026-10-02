"""一期机器人任务 JSON 的结构与安全校验。"""

from __future__ import annotations

from typing import Any, Iterable


class TaskValidationError(ValueError):
    """Raised when a task cannot be safely executed."""


ALLOWED_ACTIONS = {"move", "turn", "stop", "stop_if_obstacle", "get_status", "arm_joint", "arm6_joints"}
ALLOWED_SENSORS = {"/scan0", "/scan1"}
DEFAULT_LIMITS = {
    "max_linear": 0.3,
    "max_angular": 1.2,
    "max_duration": 30.0,
    "require_confirmation": True,
}


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TaskValidationError(f"{field} must be a number")
    return float(value)


def _require(mapping: dict[str, Any], field: str) -> Any:
    if field not in mapping:
        raise TaskValidationError(f"missing {field}")
    return mapping[field]


def validate_task(
    task: Any,
    *,
    seen_task_ids: Iterable[str] = (),
) -> dict[str, Any]:
    """Validate and return a task suitable for the executor.

    The input is not mutated. Duplicate task IDs can be rejected by passing
    IDs already accepted by the executor in ``seen_task_ids``.
    """
    if not isinstance(task, dict):
        raise TaskValidationError("task must be an object")
    if task.get("schema_version") != "1.0":
        raise TaskValidationError("schema_version must be 1.0")

    task_id = _require(task, "task_id")
    if not isinstance(task_id, str) or not task_id.strip():
        raise TaskValidationError("task_id must be a non-empty string")
    if task_id in set(seen_task_ids):
        raise TaskValidationError(f"duplicate task_id: {task_id}")

    steps = _require(task, "steps")
    if not isinstance(steps, list) or not steps:
        raise TaskValidationError("steps must be a non-empty array")

    limits = dict(DEFAULT_LIMITS)
    supplied_limits = _require(task, "limits")
    if not isinstance(supplied_limits, dict):
        raise TaskValidationError("limits must be an object")
    limits.update(supplied_limits)
    max_linear = _number(limits["max_linear"], "limits.max_linear")
    max_angular = _number(limits["max_angular"], "limits.max_angular")
    max_duration = _number(limits["max_duration"], "limits.max_duration")
    if not 0 < max_linear <= DEFAULT_LIMITS["max_linear"]:
        raise TaskValidationError("limits.max_linear exceeds safety limit")
    if not 0 < max_angular <= DEFAULT_LIMITS["max_angular"]:
        raise TaskValidationError("limits.max_angular exceeds safety limit")
    if not 0 < max_duration <= DEFAULT_LIMITS["max_duration"]:
        raise TaskValidationError("limits.max_duration exceeds safety limit")
    if not isinstance(limits["require_confirmation"], bool):
        raise TaskValidationError("limits.require_confirmation must be boolean")

    seen_step_ids: set[str] = set()
    total_duration = 0.0
    for step in steps:
        if not isinstance(step, dict):
            raise TaskValidationError("each step must be an object")
        if "id" not in step:
            raise TaskValidationError("missing step id")
        step_id = step["id"]
        if not isinstance(step_id, str) or not step_id.strip():
            raise TaskValidationError("step id must be a non-empty string")
        if step_id in seen_step_ids:
            raise TaskValidationError(f"duplicate step id: {step_id}")
        seen_step_ids.add(step_id)
        action = _require(step, "action")
        if action not in ALLOWED_ACTIONS:
            raise TaskValidationError(f"unsupported action: {action}")

        if action == "move":
            linear = abs(_number(_require(step, "linear"), "linear"))
            angular = abs(_number(_require(step, "angular"), "angular"))
            duration = _number(_require(step, "duration"), "duration")
            if linear > max_linear:
                raise TaskValidationError("linear exceeds task limit")
            if angular > max_angular:
                raise TaskValidationError("angular exceeds task limit")
            if duration <= 0:
                raise TaskValidationError("duration must be positive")
            total_duration += duration
        elif action == "turn":
            angular = abs(_number(_require(step, "angular"), "angular"))
            duration = _number(_require(step, "duration"), "duration")
            if angular > max_angular:
                raise TaskValidationError("angular exceeds task limit")
            if duration <= 0:
                raise TaskValidationError("duration must be positive")
            total_duration += duration
        elif action == "stop_if_obstacle":
            sensors = _require(step, "sensors")
            if not isinstance(sensors, list) or not sensors or not all(
                isinstance(sensor, str) and sensor in ALLOWED_SENSORS for sensor in sensors
            ):
                raise TaskValidationError("sensors must be an array of /scan0 or /scan1")
            distance = _number(_require(step, "distance"), "distance")
            if not 0 < distance <= 2.0:
                raise TaskValidationError("distance must be between 0 and 2 meters")
        elif action == "arm_joint":
            joint_id = _number(_require(step, "joint_id"), "joint_id")
            joint = _number(_require(step, "joint"), "joint")
            move_time = _number(step.get("time", 1500), "time")
            if joint_id not in range(1, 7):
                raise TaskValidationError("joint_id must be between 1 and 6")
            if not 0 <= joint <= 180:
                raise TaskValidationError("joint must be between 0 and 180 degrees")
            if not 100 <= move_time <= 10000:
                raise TaskValidationError("time must be between 100 and 10000 ms")
        elif action == "arm6_joints":
            for name in ("joint1", "joint2", "joint3", "joint4", "joint5", "joint6"):
                joint = _number(_require(step, name), name)
                if not 0 <= joint <= 180:
                    raise TaskValidationError(f"{name} must be between 0 and 180 degrees")
            move_time = _number(step.get("time", 1500), "time")
            if not 100 <= move_time <= 10000:
                raise TaskValidationError("time must be between 100 and 10000 ms")

    if total_duration > max_duration:
        raise TaskValidationError("total duration exceeds task limit")
    return {**task, "limits": limits}

"""Fixtures calibrated to RoboFrame HEAD's public robot-skill JSON contract."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from roboframe_bridge.client import (
    RobotClientError,
    RobotSkillCliClient,
    _action_command,
    _param_flags,
)
from roboframe_bridge.models import ActionRef, ExecuteRequest, ValidateRequest

SKILL = ActionRef(kind="skill", name="move_relative_ee")
PRIMITIVE = ActionRef(kind="primitive", name="open_gripper")
DIGEST = "sha256:catalog-digest"


@pytest.fixture
def real_catalog_cli_data() -> tuple[dict, dict, dict]:
    listed = {
        "robot_name": "so101_single_arm",
        "config_digest": DIGEST,
        "skills": [
            {
                "name": "move_relative_ee",
                "contract_schema_version": 2,
                "summary": "Move the end effector relative to its current pose.",
                "domain": "manipulation",
                "moves_robot": True,
                "required_control_mode": "moveit_planning",
            }
        ],
    }
    described = {
        "robot_name": "so101_single_arm",
        "name": "move_relative_ee",
        "schema_version": 2,
        "summary": "Move the end effector relative to its current pose.",
        "domain": "manipulation",
        "moves_robot": True,
        "required_control_mode": "moveit_planning",
        "parameters": {
            "type": "object",
            "properties": {
                "motion_direction": {"type": "string"},
                "motion_distance": {"type": "number"},
            },
            "required": ["motion_direction", "motion_distance"],
            "additionalProperties": False,
        },
        "recovery_policy": "never_retry",
        "timeout_policy": {
            "default_skill_timeout_sec": 120.0,
            "task_budget_sec": 180.0,
            "rpc_timeout_sec": 5.0,
        },
        "config_digest": DIGEST,
        "timeout_sec": 120.0,
    }
    poses = {
        "robot_name": "so101_single_arm",
        "config_digest": DIGEST,
        "poses": ["home", "observe_table", "zero"],
    }
    return listed, described, poses


def test_catalog_enriches_every_skill_and_merges_poses(
    monkeypatch, real_catalog_cli_data
) -> None:
    calls = _install_outputs(
        monkeypatch,
        [_instant(data) for data in real_catalog_cli_data],
    )
    client = RobotSkillCliClient(config_name="so101_single_arm")

    catalog = client.catalog()

    assert calls == [
        ["robot-skill", "--config-name", "so101_single_arm", "list-skills"],
        [
            "robot-skill",
            "--config-name",
            "so101_single_arm",
            "describe",
            "move_relative_ee",
        ],
        ["robot-skill", "--config-name", "so101_single_arm", "list-poses"],
    ]
    assert catalog.robot_name == "so101_single_arm"
    assert catalog.config_digest == DIGEST
    assert catalog.poses == ["home", "observe_table", "zero"]
    assert catalog.primitives == []
    assert len(catalog.skills) == 1
    skill = catalog.skills[0]
    assert skill.contract_schema_version == 2
    assert skill.parameters["required"] == ["motion_direction", "motion_distance"]
    assert skill.recovery_policy == "never_retry"
    assert skill.timeout_sec == 120.0
    assert skill.timeout_policy["rpc_timeout_sec"] == 5.0
    assert skill.config_digest == DIGEST


def test_status_preserves_the_real_gateway_contract(monkeypatch) -> None:
    status = {
        "schema_version": 1,
        "robot_name": "so101_single_arm",
        "motion_authorized": True,
        "active_control_mode": "moveit_planning",
        "busy": False,
        "active_task_id": "",
        "default_skill_timeout_sec": 120.0,
        "task_budget_sec": 180.0,
        "rpc_timeout_sec": 5.0,
        "config_digest": DIGEST,
        "capability_digest": "sha256:capabilities",
        "registry_epoch": "epoch-1",
        "registry_generation": 7,
        "registry_digest": "sha256:registry",
        "primitive_contract_digest": "sha256:primitives",
        "source_release_digest": "sha256:release",
        "provenance_digest": "sha256:provenance",
        "control_plane_ready": True,
        "control_plane_state": "ready",
        "control_plane_error_code": "",
        "request_state": "idle",
        "request_error_code": "",
        "capabilities": [
            {
                "name": "move_relative_ee",
                "semantic_level": "skill",
                "planner_visible": True,
                "ready": True,
                "reason": "",
                "required_control_mode": "moveit_planning",
            }
        ],
    }
    calls = _install_outputs(monkeypatch, [_instant(status)])
    client = RobotSkillCliClient(config_name="so101_single_arm")

    result = client.status()

    assert calls == [["robot-skill", "--config-name", "so101_single_arm", "status"]]
    assert result.config_digest == DIGEST
    assert result.registry_generation == 7
    assert result.control_plane_ready is True
    assert result.capabilities[0].required_control_mode == "moveit_planning"


def test_catalog_rejects_a_digest_change_during_describe(
    monkeypatch, real_catalog_cli_data
) -> None:
    listed, described, _poses = real_catalog_cli_data
    changed = {**described, "config_digest": "sha256:changed"}
    _install_outputs(monkeypatch, [_instant(listed), _instant(changed)])
    client = RobotSkillCliClient()

    with pytest.raises(RobotClientError) as caught:
        client.catalog()

    assert caught.value.code == "CATALOG_CHANGED_DURING_READ"


@pytest.mark.parametrize(
    ("allowed", "reason", "expected_valid", "expected_code"),
    [
        (True, "policy allowed", True, ""),
        (False, "workspace blocked", False, "VALIDATION_REJECTED"),
    ],
)
def test_validate_maps_allowed_and_reason(
    monkeypatch, allowed, reason, expected_valid, expected_code
) -> None:
    calls = _install_outputs(
        monkeypatch,
        [_instant({"allowed": allowed, "reason": reason, "payload": {}})],
    )
    client = RobotSkillCliClient()

    result = client.validate(
        ValidateRequest(
            action=SKILL,
            params={"motion_direction": "forward", "motion_distance": 0.03},
        )
    )

    assert result.valid is expected_valid
    assert result.error_code == expected_code
    assert result.message == reason
    assert calls[0] == [
        "robot-skill",
        "validate",
        "move_relative_ee",
        "--motion-direction",
        "forward",
        "--motion-distance",
        "0.03",
    ]


def test_validate_preserves_structured_cli_error(monkeypatch) -> None:
    _install_outputs(
        monkeypatch,
        [
            _error(
                "CAPABILITY_NOT_READY",
                "required control mode is not active",
                returncode=3,
            )
        ],
    )
    result = RobotSkillCliClient().validate(ValidateRequest(action=SKILL))

    assert result.valid is False
    assert result.error_code == "CAPABILITY_NOT_READY"
    assert result.message == "required control mode is not active"


@pytest.mark.parametrize(
    ("data", "returncode", "state", "success"),
    [
        (
            {
                "success": True,
                "error_code": "",
                "message": "completed",
                "executed_step_count": 2,
            },
            0,
            "completed",
            True,
        ),
        (
            {
                "success": False,
                "error_code": "SKILL_CANCELLED",
                "message": "cancelled",
                "executed_step_count": 1,
            },
            3,
            "canceled",
            False,
        ),
        (
            {
                "success": False,
                "error_code": "SKILL_CANCEL_TIMEOUT",
                "message": "robot stop state is unknown",
                "executed_step_count": 0,
            },
            5,
            "unknown",
            None,
        ),
        (
            {
                "success": False,
                "error_code": "CAPABILITY_NOT_READY",
                "message": "gateway rejected",
                "executed_step_count": 0,
            },
            3,
            "failed",
            False,
        ),
    ],
)
def test_execute_maps_real_result_event_even_on_nonzero_exit(
    monkeypatch, data, returncode, state, success
) -> None:
    _install_outputs(monkeypatch, [_result_event(data, returncode=returncode)])
    result = RobotSkillCliClient().execute(
        ExecuteRequest(task_id="task-1", action=SKILL)
    )

    assert result.task_id == "task-1"
    assert result.state == state
    assert result.success is success
    assert result.error_code == data["error_code"]
    assert result.executed_step_count == data["executed_step_count"]


def test_execute_keeps_timeout_separate_from_kebab_case_action_params(
    monkeypatch,
) -> None:
    calls = _install_outputs(
        monkeypatch,
        [
            _result_event(
                {
                    "success": True,
                    "error_code": "",
                    "message": "completed",
                    "executed_step_count": 1,
                }
            )
        ],
    )
    RobotSkillCliClient().execute(
        ExecuteRequest(
            task_id="task-2",
            action=SKILL,
            params={
                "motion_direction": "forward",
                "options": {"z": 2, "a": ["中文", False, None]},
                "waypoints": [{"y": 2, "x": 1}],
            },
            timeout_sec=12,
        )
    )

    assert calls[0] == [
        "robot-skill",
        "execute",
        "move_relative_ee",
        "--task-id",
        "task-2",
        "--motion-direction",
        "forward",
        "--options",
        '{"a":["中文",false,null],"z":2}',
        "--waypoints",
        '[{"x":1,"y":2}]',
        "--timeout-sec",
        "12.0",
    ]
    assert calls[0].count("--timeout-sec") == 1


def test_action_parameter_flags_reject_request_fields() -> None:
    with pytest.raises(RobotClientError) as caught:
        _param_flags({"timeout_sec": 4})
    assert caught.value.code == "INVALID_ACTION_PARAMS"


def test_real_cli_action_command_supports_skills_only() -> None:
    assert _action_command("validate", SKILL) == "validate"
    assert _action_command("execute", SKILL) == "execute"
    with pytest.raises(RobotClientError) as caught:
        _action_command("execute", PRIMITIVE)
    assert caught.value.code == "UNSUPPORTED_ACTION_KIND"


@pytest.mark.parametrize(
    ("data", "requested", "state", "confirmed"),
    [
        (
            {
                "task_id": "task-1",
                "already_terminal": False,
                "cancel": {"accepted": True, "message": "cancel accepted"},
                "status": {"request_state": "active"},
            },
            True,
            "running",
            False,
        ),
        (
            {
                "task_id": "task-1",
                "already_terminal": False,
                "cancel": {"accepted": True},
                "status": {"request_state": "terminal"},
            },
            True,
            "unknown",
            False,
        ),
        (
            {
                "task_id": "task-1",
                "already_terminal": True,
                "status": {"request_state": "terminal"},
            },
            False,
            "unknown",
            False,
        ),
    ],
)
def test_cancel_parses_nested_status_without_inventing_an_outcome(
    monkeypatch, data, requested, state, confirmed
) -> None:
    _install_outputs(monkeypatch, [_instant(data)])
    result = RobotSkillCliClient().cancel("task-1")

    assert result.requested is requested
    assert result.state == state
    assert result.confirmed is confirmed


def test_cancel_timeout_preserves_unknown_state(monkeypatch) -> None:
    _install_outputs(
        monkeypatch,
        [_error("SKILL_CANCEL_TIMEOUT", "robot stop state is unknown", returncode=5)],
    )
    result = RobotSkillCliClient().cancel("task-1")

    assert result.requested is False
    assert result.state == "unknown"
    assert result.confirmed is False
    assert "SKILL_CANCEL_TIMEOUT" in result.message


def _install_outputs(monkeypatch, outputs: list[SimpleNamespace]) -> list[list[str]]:
    pending = iter(outputs)
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        return next(pending)

    monkeypatch.setattr("roboframe_bridge.client.subprocess.run", fake_run)
    return calls


def _instant(data: dict) -> SimpleNamespace:
    envelope = {"schema_version": 1, "command": "fixture", "ok": True, "data": data}
    return SimpleNamespace(returncode=0, stdout=json.dumps(envelope) + "\n", stderr="")


def _error(code: str, message: str, *, returncode: int) -> SimpleNamespace:
    envelope = {
        "schema_version": 1,
        "command": "fixture",
        "ok": False,
        "error": {"code": code, "message": message},
    }
    return SimpleNamespace(
        returncode=returncode,
        stdout=json.dumps(envelope) + "\n",
        stderr="",
    )


def _result_event(data: dict, *, returncode: int = 0) -> SimpleNamespace:
    feedback = {
        "schema_version": 1,
        "event": "feedback",
        "task_id": "task-1",
        "payload_hash": "sha256:payload",
        "data": {"state": "executing", "detail": "fixture"},
    }
    result = {
        "schema_version": 1,
        "event": "result",
        "task_id": "task-1",
        "payload_hash": "sha256:payload",
        "data": data,
    }
    stdout = "\n".join((json.dumps(feedback), json.dumps(result))) + "\n"
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr="")

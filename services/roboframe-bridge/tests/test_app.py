"""Bridge contract tests using a fake robot client (no ROS required)."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from roboframe_bridge.app import create_app
from roboframe_bridge.client import RobotClientError, _param_flags, _task_result
from roboframe_bridge.memory import TaskRegistry
from roboframe_bridge.models import (
    CancelResult,
    Catalog,
    CatalogSkill,
    ExecuteRequest,
    GatewayStatus,
    PoseCatalog,
    TaskResult,
    ValidateRequest,
    ValidateResult,
)

TOKEN = "test-token"

SO101_SKILLS = [
    CatalogSkill(
        name="inspect_scene",
        summary="Inspect the workspace from the observation view.",
        domain="manipulation",
        required_control_mode="moveit_planning",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        recovery_policy="never_retry",
    ),
    CatalogSkill(
        name="move_relative_ee",
        summary="Move the end effector relative to its current pose.",
        domain="manipulation",
        required_control_mode="moveit_planning",
        parameters={
            "type": "object",
            "properties": {
                "motion_direction": {"type": "string"},
                "motion_distance": {"type": "number"},
            },
            "required": ["motion_direction", "motion_distance"],
            "additionalProperties": False,
        },
        recovery_policy="never_retry",
    ),
]


class FakeRobotClient:
    def __init__(self, fail_status: bool = False) -> None:
        self.fail_status = fail_status
        self.executed: list[ExecuteRequest] = []
        self.canceled: list[str] = []

    def catalog(self) -> Catalog:
        return Catalog(
            robot_name="so101_single_arm",
            config_digest="digest-1",
            skills=SO101_SKILLS,
        )

    def poses(self) -> PoseCatalog:
        return PoseCatalog(robot_name="so101_single_arm", config_digest="digest-1", poses=["home", "observe_table", "zero"])

    def status(self) -> GatewayStatus:
        if self.fail_status:
            raise RobotClientError("ros graph unavailable")
        return GatewayStatus(
            motion_authorized=True,
            active_control_mode="moveit_planning",
            required_control_mode="moveit_planning",
            busy=False,
        )

    def validate(self, request: ValidateRequest) -> ValidateResult:
        if request.skill == "move_relative_ee" and "motion_direction" not in request.params:
            return ValidateResult(valid=False, message="missing motion_direction")
        return ValidateResult(valid=True)

    def execute(self, request: ExecuteRequest) -> TaskResult:
        self.executed.append(request)
        return TaskResult(
            task_id=request.task_id,
            skill=request.skill,
            state="completed",
            success=True,
            executed_primitives=["move_relative_ee"],
        )

    def query(self, task_id: str) -> TaskResult | None:
        return None

    def cancel(self, task_id: str) -> CancelResult:
        self.canceled.append(task_id)
        return CancelResult(task_id=task_id, requested=True, state="canceled")


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(FakeRobotClient(), token=TOKEN))


@pytest.fixture
def open_client() -> TestClient:
    return TestClient(create_app(FakeRobotClient(), token=""))


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_health_is_public(client: TestClient) -> None:
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_endpoints_require_token(client: TestClient) -> None:
    for path in ("/v1/catalog", "/v1/status"):
        assert client.get(path).status_code == 401


def test_wrong_token_rejected(client: TestClient) -> None:
    response = client.get("/v1/catalog", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_catalog_lists_skills_and_digest(client: TestClient) -> None:
    response = client.get("/v1/catalog", headers=auth_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["robot_name"] == "so101_single_arm"
    assert body["config_digest"] == "digest-1"
    assert [skill["name"] for skill in body["skills"]] == ["inspect_scene", "move_relative_ee"]


def test_catalog_skill_detail_and_404(client: TestClient) -> None:
    ok = client.get("/v1/catalog/skills/inspect_scene", headers=auth_headers())
    assert ok.status_code == 200
    assert ok.json()["recovery_policy"] == "never_retry"
    missing = client.get("/v1/catalog/skills/nope", headers=auth_headers())
    assert missing.status_code == 404


def test_poses(client: TestClient) -> None:
    response = client.get("/v1/catalog/poses", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["poses"] == ["home", "observe_table", "zero"]


def test_status(client: TestClient) -> None:
    response = client.get("/v1/status", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["motion_authorized"] is True


def test_validate(client: TestClient) -> None:
    ok = client.post(
        "/v1/skills/validate",
        headers=auth_headers(),
        json={"skill": "move_relative_ee", "params": {"motion_direction": "forward", "motion_distance": 0.03}},
    )
    assert ok.status_code == 200
    assert ok.json()["valid"] is True

    bad = client.post("/v1/skills/validate", headers=auth_headers(), json={"skill": "move_relative_ee", "params": {}})
    assert bad.json()["valid"] is False


def test_execute_is_async_and_query_returns_terminal(client: TestClient) -> None:
    response = client.post(
        "/v1/skills/execute",
        headers=auth_headers(),
        json={"task_id": "task-1", "skill": "inspect_scene", "params": {}},
    )
    assert response.status_code == 202
    assert response.json() == {"accepted": True, "task_id": "task-1", "skill": "inspect_scene"}

    body = _poll_task(client, "task-1")
    assert body["state"] == "completed"
    assert body["executed_primitives"] == ["move_relative_ee"]


def test_execute_unknown_skill_404(client: TestClient) -> None:
    response = client.post(
        "/v1/skills/execute",
        headers=auth_headers(),
        json={"task_id": "task-2", "skill": "nope", "params": {}},
    )
    assert response.status_code == 404


def test_execute_rejects_bad_payload(client: TestClient) -> None:
    response = client.post(
        "/v1/skills/execute",
        headers=auth_headers(),
        json={"task_id": "", "skill": "inspect_scene"},
    )
    assert response.status_code == 422


def test_unknown_task_404(client: TestClient) -> None:
    response = client.get("/v1/tasks/missing", headers=auth_headers())
    assert response.status_code == 404


def test_robot_boundary_error_maps_to_502() -> None:
    failing = TestClient(create_app(FakeRobotClient(fail_status=True), token=TOKEN))
    response = failing.get("/v1/status", headers=auth_headers())
    assert response.status_code == 502


def test_cancel(client: TestClient) -> None:
    response = client.post("/v1/tasks/task-9/cancel", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["requested"] is True
    assert _poll_task(client, "task-9")["state"] == "canceled"


def test_registry_is_bounded() -> None:
    registry = TaskRegistry(capacity=2)
    for index in range(3):
        registry.record(TaskResult(task_id=f"t{index}", skill="inspect_scene", state="completed"))
    assert registry.get("t0") is None
    assert registry.get("t2") is not None


def test_open_token_disables_auth(open_client: TestClient) -> None:
    assert open_client.get("/v1/catalog").status_code == 200


def test_cli_param_flags_and_task_result() -> None:
    flags = _param_flags({"motion_direction": "forward", "motion_distance": 0.03, "force": True})
    assert flags == ["--motion_direction", "forward", "--motion_distance", "0.03", "--force", "true"]
    result = _task_result({"state": "failed", "message": "boom"}, "t1", "inspect_scene")
    assert result.task_id == "t1"
    assert result.state == "failed"
    assert result.message == "boom"


def _poll_task(client: TestClient, task_id: str, attempts: int = 50) -> dict:
    for _ in range(attempts):
        response = client.get(f"/v1/tasks/{task_id}", headers=auth_headers())
        if response.status_code == 200:
            if response.headers.get("X-Terminal-State") == "True":
                return response.json()
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} never reached a terminal state")

"""Bridge contract tests using a fake robot client (no ROS required)."""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from roboframe_bridge.app import create_app
from roboframe_bridge.client import RobotClientError
from roboframe_bridge.memory import TaskConflict, TaskRegistry
from roboframe_bridge.models import (
    ActionRef,
    CancelResult,
    Catalog,
    CatalogPrimitive,
    CatalogSkill,
    ExecuteRequest,
    GatewayStatus,
    PoseCatalog,
    TaskResult,
    ValidateRequest,
    ValidateResult,
)

TOKEN = "test-token"
SKILL = ActionRef(kind="skill", name="inspect_scene")
PRIMITIVE = ActionRef(kind="primitive", name="open_gripper")

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

SO101_PRIMITIVES = [
    CatalogPrimitive(
        name="open_gripper",
        summary="Open the gripper.",
        domain="manipulation",
        required_control_mode="moveit_planning",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
]


class FakeRobotClient:
    def __init__(
        self,
        *,
        fail_status: bool = False,
        execute_error: BaseException | None = None,
        execute_state: str = "completed",
        release: threading.Event | None = None,
        cancel_state: str = "canceled",
        cancel_error: BaseException | None = None,
    ) -> None:
        self.fail_status = fail_status
        self.execute_error = execute_error
        self.execute_state = execute_state
        self.release = release
        self.cancel_state = cancel_state
        self.cancel_error = cancel_error
        self.started = threading.Event()
        self.executed: list[ExecuteRequest] = []
        self.validated: list[ValidateRequest] = []
        self.canceled: list[str] = []

    def catalog(self) -> Catalog:
        return Catalog(
            robot_name="so101_single_arm",
            config_digest="digest-1",
            skills=SO101_SKILLS,
            primitives=SO101_PRIMITIVES,
            poses=["home", "observe_table", "zero"],
        )

    def poses(self) -> PoseCatalog:
        return PoseCatalog(
            robot_name="so101_single_arm",
            config_digest="digest-1",
            poses=["home", "observe_table", "zero"],
        )

    def status(self) -> GatewayStatus:
        if self.fail_status:
            raise RobotClientError("ros graph unavailable")
        return GatewayStatus(
            schema_version=1,
            robot_name="so101_single_arm",
            motion_authorized=True,
            active_control_mode="moveit_planning",
            busy=False,
            active_task_id="",
            default_skill_timeout_sec=120.0,
            task_budget_sec=180.0,
            rpc_timeout_sec=5.0,
            config_digest="digest-1",
            capability_digest="capability-digest-1",
            registry_epoch="epoch-1",
            registry_generation=7,
            registry_digest="registry-digest-1",
            primitive_contract_digest="primitive-digest-1",
            source_release_digest="release-digest-1",
            provenance_digest="provenance-digest-1",
            control_plane_ready=True,
            control_plane_state="ready",
            control_plane_error_code="",
            request_state="idle",
            request_error_code="",
            capabilities=[
                {
                    "name": "move_relative_ee",
                    "semantic_level": "skill",
                    "planner_visible": True,
                    "ready": True,
                    "reason": "",
                    "required_control_mode": "moveit_planning",
                }
            ],
        )

    def validate(self, request: ValidateRequest) -> ValidateResult:
        self.validated.append(request)
        if (
            request.action.name == "move_relative_ee"
            and "motion_direction" not in request.params
        ):
            return ValidateResult(valid=False, message="missing motion_direction")
        return ValidateResult(valid=True)

    def execute(self, request: ExecuteRequest) -> TaskResult:
        self.executed.append(request)
        self.started.set()
        if self.release is not None:
            self.release.wait(timeout=5)
        if self.execute_error is not None:
            raise self.execute_error
        return TaskResult(
            task_id=request.task_id,
            action=request.action,
            state=self.execute_state,
            success=self.execute_state == "completed",
            executed_step_count=1,
        )

    def query(self, task_id: str) -> TaskResult | None:
        return None

    def cancel(self, task_id: str) -> CancelResult:
        self.canceled.append(task_id)
        if self.cancel_error is not None:
            raise self.cancel_error
        if task_id not in {request.task_id for request in self.executed}:
            return CancelResult(task_id=task_id, requested=False, state="unknown")
        return CancelResult(task_id=task_id, requested=True, state=self.cancel_state)


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
    assert response.json()["version"] == "0.2.0"


def test_endpoints_require_token(client: TestClient) -> None:
    for path in ("/v1/catalog", "/v1/status"):
        assert client.get(path).status_code == 401


def test_wrong_token_rejected(client: TestClient) -> None:
    response = client.get("/v1/catalog", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_catalog_lists_discriminated_actions_and_digest(client: TestClient) -> None:
    response = client.get("/v1/catalog", headers=auth_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["robot_name"] == "so101_single_arm"
    assert body["config_digest"] == "digest-1"
    assert [(item["kind"], item["name"]) for item in body["skills"]] == [
        ("skill", "inspect_scene"),
        ("skill", "move_relative_ee"),
    ]
    assert [(item["kind"], item["name"]) for item in body["primitives"]] == [
        ("primitive", "open_gripper")
    ]


def test_catalog_action_details(client: TestClient) -> None:
    skill = client.get("/v1/catalog/skills/inspect_scene", headers=auth_headers())
    assert skill.status_code == 200
    assert skill.json()["kind"] == "skill"

    primitive = client.get(
        "/v1/catalog/primitives/open_gripper", headers=auth_headers()
    )
    assert primitive.status_code == 200
    assert primitive.json()["kind"] == "primitive"

    assert (
        client.get("/v1/catalog/skills/missing", headers=auth_headers()).status_code
        == 404
    )
    assert (
        client.get("/v1/catalog/primitives/missing", headers=auth_headers()).status_code
        == 404
    )


def test_poses(client: TestClient) -> None:
    response = client.get("/v1/catalog/poses", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["poses"] == ["home", "observe_table", "zero"]


def test_status(client: TestClient) -> None:
    response = client.get("/v1/status", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["motion_authorized"] is True
    assert response.json()["config_digest"] == "digest-1"
    assert response.json()["capabilities"][0]["name"] == "move_relative_ee"


@pytest.mark.parametrize(
    ("action", "params"),
    [
        ({"kind": "skill", "name": "inspect_scene"}, {}),
        ({"kind": "primitive", "name": "open_gripper"}, {"profile": {"speed": 0.2}}),
    ],
)
def test_validate_routes_by_action_kind(
    action: dict[str, str], params: dict[str, object]
) -> None:
    fake = FakeRobotClient()
    api = TestClient(create_app(fake, token=TOKEN))
    response = api.post(
        "/v1/actions/validate",
        headers=auth_headers(),
        json={"action": action, "params": params},
    )
    assert response.status_code == 200
    assert response.json()["valid"] is True
    assert fake.validated[0].action.kind == action["kind"]


def test_validate_unknown_action_404(client: TestClient) -> None:
    response = client.post(
        "/v1/actions/validate",
        headers=auth_headers(),
        json={"action": {"kind": "primitive", "name": "inspect_scene"}, "params": {}},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "unknown primitive: inspect_scene"


def test_old_skill_action_paths_are_absent(client: TestClient) -> None:
    assert (
        client.post("/v1/skills/validate", headers=auth_headers(), json={}).status_code
        == 404
    )
    assert (
        client.post("/v1/skills/execute", headers=auth_headers(), json={}).status_code
        == 404
    )


def test_execute_is_accepted_and_running_task_is_immediately_queryable() -> None:
    release = threading.Event()
    fake = FakeRobotClient(release=release)
    api = TestClient(create_app(fake, token=TOKEN))

    response = _execute(api, "slow-1", SKILL)
    assert response.status_code == 202
    assert response.json() == {
        "accepted": True,
        "task_id": "slow-1",
        "action": {"kind": "skill", "name": "inspect_scene"},
        "state": "accepted",
    }
    assert fake.started.wait(timeout=1)

    active = api.get("/v1/tasks/slow-1", headers=auth_headers())
    assert active.status_code == 200
    assert active.json()["state"] == "running"
    assert active.json()["terminal"] is False
    assert active.json()["context"] == {"workflowNodeId": "node-1"}
    assert active.headers["X-Terminal-State"] == "False"

    release.set()
    terminal = _poll_task(api, "slow-1")
    assert terminal["state"] == "completed"
    assert terminal["terminal"] is True
    assert terminal["executed_step_count"] == 1
    assert terminal["accepted_at"] is not None
    assert terminal["started_at"] is not None
    assert terminal["finished_at"] is not None


def test_execute_primitive_preserves_action_kind() -> None:
    fake = FakeRobotClient()
    api = TestClient(create_app(fake, token=TOKEN))
    response = _execute(api, "primitive-1", PRIMITIVE)
    assert response.status_code == 202
    body = _poll_task(api, "primitive-1")
    assert body["action"] == {"kind": "primitive", "name": "open_gripper"}
    assert fake.executed[0].action.kind == "primitive"


def test_duplicate_task_id_is_a_deterministic_conflict() -> None:
    release = threading.Event()
    fake = FakeRobotClient(release=release)
    api = TestClient(create_app(fake, token=TOKEN))
    assert _execute(api, "duplicate-1", SKILL).status_code == 202
    assert fake.started.wait(timeout=1)

    duplicate = api.post(
        "/v1/actions/execute",
        headers=auth_headers(),
        json={
            "task_id": "duplicate-1",
            "action": {"kind": "primitive", "name": "missing"},
            "params": {},
        },
    )
    assert duplicate.status_code == 409
    assert (
        duplicate.json()["detail"]
        == "task_id already exists: duplicate-1 (state=running)"
    )
    assert len(fake.executed) == 1
    release.set()
    _poll_task(api, "duplicate-1")

    terminal_duplicate = _execute(api, "duplicate-1", SKILL)
    assert terminal_duplicate.status_code == 409
    assert "state=completed" in terminal_duplicate.json()["detail"]


def test_execute_unknown_action_and_bad_payload(client: TestClient) -> None:
    missing = client.post(
        "/v1/actions/execute",
        headers=auth_headers(),
        json={
            "task_id": "missing-1",
            "action": {"kind": "skill", "name": "missing"},
            "params": {},
        },
    )
    assert missing.status_code == 404

    bad = client.post(
        "/v1/actions/execute",
        headers=auth_headers(),
        json={"task_id": "", "action": {"kind": "skill", "name": "inspect_scene"}},
    )
    assert bad.status_code == 422

    legacy_shape = client.post(
        "/v1/actions/execute",
        headers=auth_headers(),
        json={"task_id": "legacy-1", "skill": "inspect_scene"},
    )
    assert legacy_shape.status_code == 422


@pytest.mark.parametrize(
    ("error", "state", "error_code"),
    [
        (RobotClientError("gateway rejected"), "failed", "ROBOT_BOUNDARY_ERROR"),
        (RuntimeError("worker crashed"), "unknown", "BRIDGE_EXECUTION_EXCEPTION"),
    ],
)
def test_execute_thread_exceptions_are_recorded(
    error: BaseException, state: str, error_code: str
) -> None:
    api = TestClient(create_app(FakeRobotClient(execute_error=error), token=TOKEN))
    assert _execute(api, f"error-{state}", SKILL).status_code == 202
    body = _poll_task(api, f"error-{state}")
    assert body["state"] == state
    assert body["error_code"] == error_code


def test_non_terminal_execute_result_becomes_unknown() -> None:
    api = TestClient(create_app(FakeRobotClient(execute_state="running"), token=TOKEN))
    assert _execute(api, "bad-terminal-1", SKILL).status_code == 202
    body = _poll_task(api, "bad-terminal-1")
    assert body["state"] == "unknown"
    assert body["error_code"] == "NON_TERMINAL_EXECUTION_RESULT"


def test_unknown_task_404(client: TestClient) -> None:
    response = client.get("/v1/tasks/missing", headers=auth_headers())
    assert response.status_code == 404


def test_robot_boundary_error_maps_to_502() -> None:
    failing = TestClient(create_app(FakeRobotClient(fail_status=True), token=TOKEN))
    response = failing.get("/v1/status", headers=auth_headers())
    assert response.status_code == 502


def test_cancel_confirms_terminal_and_terminal_is_stable() -> None:
    release = threading.Event()
    fake = FakeRobotClient(release=release, cancel_state="canceled")
    api = TestClient(create_app(fake, token=TOKEN))
    assert _execute(api, "cancel-1", SKILL).status_code == 202
    assert fake.started.wait(timeout=1)

    response = api.post("/v1/tasks/cancel-1/cancel", headers=auth_headers())
    assert response.status_code == 200
    assert response.json() == {
        "task_id": "cancel-1",
        "requested": True,
        "state": "canceled",
        "message": "",
        "confirmed": True,
    }
    canceled = _poll_task(api, "cancel-1")
    assert canceled["state"] == "canceled"
    assert canceled["cancel_requested"] is True

    release.set()
    time.sleep(0.03)
    assert (
        api.get("/v1/tasks/cancel-1", headers=auth_headers()).json()["state"]
        == "canceled"
    )

    repeated = api.post("/v1/tasks/cancel-1/cancel", headers=auth_headers())
    assert repeated.json()["requested"] is False
    assert repeated.json()["confirmed"] is True
    assert fake.canceled == ["cancel-1"]


def test_cancel_request_can_remain_running_until_execution_finishes() -> None:
    release = threading.Event()
    fake = FakeRobotClient(release=release, cancel_state="running")
    api = TestClient(create_app(fake, token=TOKEN))
    assert _execute(api, "cancel-pending-1", SKILL).status_code == 202
    assert fake.started.wait(timeout=1)

    response = api.post("/v1/tasks/cancel-pending-1/cancel", headers=auth_headers())
    assert response.json()["state"] == "running"
    assert response.json()["confirmed"] is False
    active = api.get("/v1/tasks/cancel-pending-1", headers=auth_headers()).json()
    assert active["state"] == "running"
    assert active["cancel_requested"] is True

    release.set()
    assert _poll_task(api, "cancel-pending-1")["state"] == "completed"


def test_cancel_exception_records_unknown() -> None:
    release = threading.Event()
    fake = FakeRobotClient(
        release=release, cancel_error=RuntimeError("cancel transport lost")
    )
    api = TestClient(create_app(fake, token=TOKEN))
    assert _execute(api, "cancel-error-1", SKILL).status_code == 202
    assert fake.started.wait(timeout=1)

    response = api.post("/v1/tasks/cancel-error-1/cancel", headers=auth_headers())
    assert response.json()["state"] == "unknown"
    assert response.json()["confirmed"] is False
    task = api.get("/v1/tasks/cancel-error-1", headers=auth_headers())
    assert task.status_code == 200
    assert task.json()["state"] == "unknown"
    assert task.json()["cancel_requested"] is True
    release.set()


def test_cancel_unknown_task_reports_unknown_without_creating_history(
    client: TestClient,
) -> None:
    response = client.post("/v1/tasks/missing/cancel", headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["state"] == "unknown"
    assert response.json()["confirmed"] is False
    assert client.get("/v1/tasks/missing", headers=auth_headers()).status_code == 404


def test_registry_reserves_ids_and_bounds_only_terminal_history() -> None:
    registry = TaskRegistry(capacity=2)
    active_request = ExecuteRequest(task_id="active", action=SKILL)
    accepted = registry.accept(active_request)
    assert accepted.state == "accepted"
    assert accepted.accepted_at is not None

    with pytest.raises(TaskConflict):
        registry.accept(active_request)

    for index in range(3):
        registry.record(
            TaskResult(
                task_id=f"t{index}", action=SKILL, state="completed", success=True
            )
        )
    assert registry.get("t0") is None
    assert registry.get("t1") is not None
    assert registry.get("t2") is not None
    assert registry.get("active") is not None


def test_registry_prevents_state_regression_and_refines_unknown() -> None:
    registry = TaskRegistry()
    registry.accept(ExecuteRequest(task_id="state-1", action=SKILL))
    registry.mark_running("state-1")
    assert (
        registry.record(
            TaskResult(task_id="state-1", action=SKILL, state="accepted")
        ).state
        == "running"
    )

    registry.record(TaskResult(task_id="state-1", action=SKILL, state="unknown"))
    assert (
        registry.record(
            TaskResult(task_id="state-1", action=SKILL, state="running")
        ).state
        == "unknown"
    )
    confirmed = registry.record(
        TaskResult(task_id="state-1", action=SKILL, state="completed", success=True)
    )
    assert confirmed.state == "completed"


def test_open_token_disables_auth(open_client: TestClient) -> None:
    assert open_client.get("/v1/catalog").status_code == 200


def _execute(api: TestClient, task_id: str, action: ActionRef):
    return api.post(
        "/v1/actions/execute",
        headers=auth_headers(),
        json={
            "task_id": task_id,
            "action": action.model_dump(),
            "params": {},
            "context": {"workflowNodeId": "node-1"},
        },
    )


def _poll_task(client: TestClient, task_id: str, attempts: int = 100) -> dict:
    latest = None
    for _ in range(attempts):
        response = client.get(f"/v1/tasks/{task_id}", headers=auth_headers())
        if response.status_code == 200:
            latest = response
            if response.headers.get("X-Terminal-State") == "True":
                return response.json()
        time.sleep(0.01)
    detail = None if latest is None else latest.json()
    raise AssertionError(f"task {task_id} never reached a terminal state: {detail}")

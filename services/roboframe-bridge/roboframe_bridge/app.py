"""RoboFrame HTTP Bridge — REST façade over the robot-skill sanctioned boundary.

Deployment (see README): run inside the robot-side ROS environment. Security
model: bearer token, no TLS termination (use a reverse proxy across network
segments), and no authorize_motion endpoint — motion authorization stays an
operator launch-time action.
"""

from __future__ import annotations

import os
import secrets
import threading

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import __version__
from .client import RobotClient, RobotClientError
from .memory import TaskConflict, TaskRegistry
from .models import (
    CONFIRMED_STATES,
    TERMINAL_STATES,
    ActionRef,
    CancelResult,
    Catalog,
    CatalogCapability,
    CatalogPrimitive,
    CatalogSkill,
    ExecuteAccepted,
    ExecuteRequest,
    GatewayStatus,
    Health,
    PoseCatalog,
    TaskResult,
    ValidateRequest,
    ValidateResult,
)


def create_app(
    client: RobotClient,
    token: str | None = None,
    registry: TaskRegistry | None = None,
) -> FastAPI:
    """Build the bridge app.

    token=None disables bearer auth (local development only). In production the
    token comes from ROBOFRAME_BRIDGE_TOKEN and is provisioned at deploy time.
    """
    app = FastAPI(title="RoboFrame Bridge", version=__version__)
    registry = registry or TaskRegistry()
    token = token if token is not None else os.environ.get("ROBOFRAME_BRIDGE_TOKEN", "")
    security = HTTPBearer(auto_error=False)

    def require_token(
        credentials: HTTPAuthorizationCredentials | None = Depends(security),
    ) -> None:
        if not token:
            return
        if credentials is None or not secrets.compare_digest(
            credentials.credentials, token
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid or missing bearer token",
            )

    guarded = Depends(require_token)

    @app.get("/v1/health")
    def health() -> Health:
        return Health(version=__version__)

    @app.get("/v1/catalog", dependencies=[guarded])
    def catalog() -> Catalog:
        return _dispatch(client.catalog)

    @app.get("/v1/catalog/skills/{skill_name}", dependencies=[guarded])
    def catalog_skill(skill_name: str) -> CatalogSkill:
        catalog_data = _dispatch(client.catalog)
        for skill in catalog_data.skills:
            if skill.name == skill_name:
                return skill
        raise HTTPException(status_code=404, detail=f"unknown skill: {skill_name}")

    @app.get("/v1/catalog/primitives/{primitive_name}", dependencies=[guarded])
    def catalog_primitive(primitive_name: str) -> CatalogPrimitive:
        catalog_data = _dispatch(client.catalog)
        for primitive in catalog_data.primitives:
            if primitive.name == primitive_name:
                return primitive
        raise HTTPException(
            status_code=404, detail=f"unknown primitive: {primitive_name}"
        )

    @app.get("/v1/catalog/poses", dependencies=[guarded])
    def poses() -> PoseCatalog:
        return _dispatch(client.poses)

    @app.get("/v1/status", dependencies=[guarded])
    def robot_status() -> GatewayStatus:
        return _dispatch(client.status)

    @app.post("/v1/actions/validate", dependencies=[guarded])
    def validate(request: ValidateRequest) -> ValidateResult:
        catalog_data = _dispatch(client.catalog)
        _require_catalog_action(catalog_data, request.action)
        return _dispatch(lambda: client.validate(request))

    @app.post("/v1/actions/execute", dependencies=[guarded], status_code=202)
    def execute(request: ExecuteRequest) -> ExecuteAccepted:
        existing = registry.get(request.task_id)
        if existing is not None:
            _raise_task_conflict(existing)

        catalog_data = _dispatch(client.catalog)
        _require_catalog_action(catalog_data, request.action)

        try:
            registry.accept(request)
        except TaskConflict as exc:
            _raise_task_conflict(exc.existing, cause=exc)

        def run() -> None:
            running = registry.mark_running(request.task_id)
            if running is None or running.state in TERMINAL_STATES:
                return
            try:
                result = client.execute(request)
                if not isinstance(result, TaskResult):
                    raise TypeError("robot client execute returned an invalid result")
                if result.state not in TERMINAL_STATES:
                    result = TaskResult(
                        task_id=request.task_id,
                        action=request.action,
                        state="unknown",
                        error_code="NON_TERMINAL_EXECUTION_RESULT",
                        message=f"robot boundary returned non-terminal state: {result.state}",
                    )
                else:
                    result = result.model_copy(
                        update={"task_id": request.task_id, "action": request.action}
                    )
            except RobotClientError as exc:
                result = TaskResult(
                    task_id=request.task_id,
                    action=request.action,
                    state="failed",
                    success=False,
                    error_code="ROBOT_BOUNDARY_ERROR",
                    message=str(exc),
                )
            except Exception as exc:
                result = TaskResult(
                    task_id=request.task_id,
                    action=request.action,
                    state="unknown",
                    error_code="BRIDGE_EXECUTION_EXCEPTION",
                    message=f"{type(exc).__name__}: {exc}",
                )
            registry.record(result)

        try:
            threading.Thread(target=run, daemon=True).start()
        except Exception as exc:
            registry.record(
                TaskResult(
                    task_id=request.task_id,
                    action=request.action,
                    state="unknown",
                    error_code="BRIDGE_THREAD_START_FAILED",
                    message=f"{type(exc).__name__}: {exc}",
                )
            )
        return ExecuteAccepted(task_id=request.task_id, action=request.action)

    @app.get("/v1/tasks/{task_id}", dependencies=[guarded])
    def task(task_id: str, response: Response) -> TaskResult:
        result = registry.get(task_id)
        if result is None:
            result = _dispatch(lambda: client.query(task_id))
            if result is not None:
                result = registry.record(result)
        if result is None:
            raise HTTPException(status_code=404, detail=f"unknown task: {task_id}")
        response.headers["X-Terminal-State"] = str(result.terminal)
        return result

    @app.post("/v1/tasks/{task_id}/cancel", dependencies=[guarded])
    def cancel(task_id: str) -> CancelResult:
        current = registry.get(task_id)
        if current is not None and current.state in CONFIRMED_STATES:
            return CancelResult(
                task_id=task_id,
                requested=False,
                state=current.state,
                message="task already has a confirmed terminal state",
            )

        if current is not None:
            current = registry.mark_cancel_requested(task_id)

        try:
            result = client.cancel(task_id)
            if not isinstance(result, CancelResult):
                raise TypeError("robot client cancel returned an invalid result")
        except Exception as exc:
            result = CancelResult(
                task_id=task_id,
                requested=False,
                state="unknown",
                message=f"{type(exc).__name__}: {exc}",
            )

        if current is None:
            return result

        if result.state in TERMINAL_STATES:
            stored = registry.record(
                TaskResult(
                    task_id=task_id,
                    action=current.action,
                    state=result.state,
                    success=_success_for_state(result.state),
                    message=result.message,
                    cancel_requested=True,
                )
            )
            return result.model_copy(update={"task_id": task_id, "state": stored.state})

        latest = registry.get(task_id)
        state_value = latest.state if latest is not None else "unknown"
        return result.model_copy(update={"task_id": task_id, "state": state_value})

    return app


def _require_catalog_action(catalog: Catalog, action: ActionRef) -> CatalogCapability:
    capabilities: list[CatalogCapability]
    if action.kind == "skill":
        capabilities = list(catalog.skills)
    else:
        capabilities = list(catalog.primitives)
    for capability in capabilities:
        if capability.name == action.name:
            return capability
    raise HTTPException(status_code=404, detail=f"unknown {action.kind}: {action.name}")


def _success_for_state(state_value: str) -> bool | None:
    if state_value == "completed":
        return True
    if state_value in {"failed", "canceled"}:
        return False
    return None


def _raise_task_conflict(existing: TaskResult, cause: Exception | None = None) -> None:
    error = HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"task_id already exists: {existing.task_id} (state={existing.state})",
    )
    if cause is not None:
        raise error from cause
    raise error


def _dispatch(call):
    try:
        return call()
    except RobotClientError as exc:
        raise HTTPException(
            status_code=502, detail=f"robot boundary error: {exc}"
        ) from exc


def build_default_client():  # pragma: no cover - wiring only, exercised on the robot
    from .client import RobotSkillCliClient

    return RobotSkillCliClient(
        robot_skill_bin=os.environ.get("ROBOT_SKILL_BIN", "robot-skill"),
        config_name=os.environ.get("ROBOT_CONFIG_NAME") or None,
        config_path=os.environ.get("ROBOT_CONFIG_PATH") or None,
    )


def main() -> None:  # pragma: no cover - entry point
    import uvicorn

    app = create_app(build_default_client())
    uvicorn.run(
        app,
        host=os.environ.get("ROBOFRAME_BRIDGE_BIND", "127.0.0.1"),
        port=int(os.environ.get("ROBOFRAME_BRIDGE_PORT", "8090")),
    )

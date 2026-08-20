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
from .client import RobotClient, RobotClientError, SkillNotFound
from .memory import TaskRegistry
from .models import (
    CancelResult,
    Catalog,
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

TERMINAL_STATES = {"completed", "failed", "canceled", "unknown"}


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
        if credentials is None or not secrets.compare_digest(credentials.credentials, token):
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

    @app.get("/v1/catalog/poses", dependencies=[guarded])
    def poses() -> PoseCatalog:
        return _dispatch(client.poses)

    @app.get("/v1/status", dependencies=[guarded])
    def robot_status() -> GatewayStatus:
        return _dispatch(client.status)

    @app.post("/v1/skills/validate", dependencies=[guarded])
    def validate(request: ValidateRequest) -> ValidateResult:
        return _dispatch(lambda: client.validate(request))

    @app.post("/v1/skills/execute", dependencies=[guarded], status_code=202)
    def execute(request: ExecuteRequest) -> ExecuteAccepted:
        catalog_data = _dispatch(client.catalog)
        if request.skill not in {skill.name for skill in catalog_data.skills}:
            raise HTTPException(status_code=404, detail=f"unknown skill: {request.skill}")

        def run() -> None:
            # Failures surface through the task registry, never the request.
            result = client.execute(request)
            registry.record(result)

        threading.Thread(target=run, daemon=True).start()
        return ExecuteAccepted(task_id=request.task_id, skill=request.skill)

    @app.get("/v1/tasks/{task_id}", dependencies=[guarded])
    def task(task_id: str, response: Response) -> TaskResult:
        result = registry.get(task_id)
        if result is None:
            result = _dispatch(lambda: client.query(task_id))
        if result is None:
            raise HTTPException(status_code=404, detail=f"unknown task: {task_id}")
        response.headers["X-Terminal-State"] = str(result.state in TERMINAL_STATES)
        return result

    @app.post("/v1/tasks/{task_id}/cancel", dependencies=[guarded])
    def cancel(task_id: str) -> CancelResult:
        result = _dispatch(lambda: client.cancel(task_id))
        if result.task_id in TERMINAL_STATES or result.state in TERMINAL_STATES:
            registry.record(
                TaskResult(
                    task_id=task_id,
                    skill="",
                    state=result.state,
                    message=result.message,
                )
            )
        return result

    return app


def _dispatch(call):
    try:
        return call()
    except SkillNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RobotClientError as exc:
        raise HTTPException(status_code=502, detail=f"robot boundary error: {exc}") from exc


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

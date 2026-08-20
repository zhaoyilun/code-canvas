"""RobotClient: the adapter seam between the bridge and RoboFrame.

The production client shells out to the `robot-skill` CLI, which is the
sanctioned agent boundary (catalog/status/validate/execute/cancel). The bridge
itself never talks to ros2_control, MoveIt, /task_executor/*, or any controller.
Tests inject a fake client implementing the same protocol.
"""

from __future__ import annotations

import json
import shlex
import subprocess
from typing import Any, Protocol

from .models import (
    Catalog,
    CancelResult,
    ExecuteRequest,
    GatewayStatus,
    PoseCatalog,
    TaskResult,
    ValidateRequest,
    ValidateResult,
)

DEFAULT_TIMEOUT_SEC = 60.0
CANCEL_SETTLE_TIMEOUT_SEC = 30.0


class RobotClientError(Exception):
    """A call into the robot boundary failed (non-zero exit, bad output)."""


class SkillNotFound(RobotClientError):
    pass


class RobotClient(Protocol):
    def catalog(self) -> Catalog: ...
    def poses(self) -> PoseCatalog: ...
    def status(self) -> GatewayStatus: ...
    def validate(self, request: ValidateRequest) -> ValidateResult: ...
    def execute(self, request: ExecuteRequest) -> TaskResult: ...
    def query(self, task_id: str) -> TaskResult | None: ...
    def cancel(self, task_id: str) -> CancelResult: ...


class RobotSkillCliClient:
    """Adapter over the `robot-skill` CLI.

    All commands share the same config resolution flags; `--json` keeps parsing
    deterministic. Execute/cancel block until the CLI reports a terminal state.
    """

    def __init__(
        self,
        robot_skill_bin: str = "robot-skill",
        config_name: str | None = None,
        config_path: str | None = None,
    ) -> None:
        if config_name and config_path:
            raise ValueError("config_name and config_path are mutually exclusive")
        self._bin = robot_skill_bin
        self._config_args: list[str] = []
        if config_name:
            self._config_args = ["--config-name", config_name]
        elif config_path:
            self._config_args = ["--config-path", config_path]

    def _run(self, args: list[str], timeout: float = DEFAULT_TIMEOUT_SEC) -> dict[str, Any]:
        cmd = [self._bin, *self._config_args, *args, "--json"]
        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise RobotClientError(f"robot-skill invocation failed: {exc}") from exc
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or f"exit {completed.returncode}"
            raise RobotClientError(stderr)
        try:
            parsed = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise RobotClientError(f"robot-skill returned non-JSON output: {exc}") from exc
        if not isinstance(parsed, dict):
            raise RobotClientError("robot-skill output was not a JSON object")
        return parsed

    def catalog(self) -> Catalog:
        return Catalog.model_validate(self._run(["list-skills"]))

    def poses(self) -> PoseCatalog:
        return PoseCatalog.model_validate(self._run(["list-poses"]))

    def status(self) -> GatewayStatus:
        return GatewayStatus.model_validate(self._run(["status"]))

    def validate(self, request: ValidateRequest) -> ValidateResult:
        args = ["validate", request.skill, *_param_flags(request.params)]
        try:
            data = self._run(args)
        except RobotClientError as exc:
            return ValidateResult(valid=False, message=str(exc))
        return ValidateResult.model_validate(data)

    def execute(self, request: ExecuteRequest) -> TaskResult:
        args = [
            "execute",
            request.skill,
            "--task-id",
            request.task_id,
            *_param_flags(request.params),
        ]
        if request.timeout_sec is not None:
            args += ["--timeout-sec", str(request.timeout_sec)]
        try:
            data = self._run(args, timeout=_execute_timeout(request))
        except RobotClientError as exc:
            return TaskResult(
                task_id=request.task_id,
                skill=request.skill,
                state="failed",
                success=False,
                message=str(exc),
            )
        return _task_result(data, request.task_id, request.skill)

    def query(self, task_id: str) -> TaskResult | None:
        return None  # CLI executions are synchronous; the registry owns history.

    def cancel(self, task_id: str) -> CancelResult:
        try:
            data = self._run(["cancel", "--task-id", task_id], timeout=CANCEL_SETTLE_TIMEOUT_SEC)
        except RobotClientError as exc:
            return CancelResult(
                task_id=task_id,
                requested=False,
                state="unknown",
                message=str(exc),
            )
        return CancelResult.model_validate(data)


def _param_flags(params: dict[str, Any]) -> list[str]:
    flags: list[str] = []
    for key, value in params.items():
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        else:
            rendered = str(value)
        flags += [f"--{key}", rendered]
    return flags


def _execute_timeout(request: ExecuteRequest) -> float:
    # CLI overhead on top of the skill timeout itself.
    base = request.timeout_sec or DEFAULT_TIMEOUT_SEC
    return base + 30.0


def _task_result(data: dict[str, Any], task_id: str, skill: str) -> TaskResult:
    return TaskResult(
        task_id=str(data.get("task_id", task_id)),
        skill=str(data.get("skill", skill)),
        state=str(data.get("state", "completed")),
        success=data.get("success"),
        error_code=str(data.get("error_code", "")),
        message=str(data.get("message", "")),
        executed_primitives=[str(p) for p in data.get("executed_primitives", [])],
    )


def quote_for_log(args: list[str]) -> str:
    return " ".join(shlex.quote(a) for a in args)

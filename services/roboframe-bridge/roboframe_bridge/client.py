"""Adapter seam between the HTTP bridge and the RoboFrame CLI boundary."""

from __future__ import annotations

import json
import re
import shlex
import subprocess
from typing import Any, Protocol

from pydantic import ValidationError

from .models import (
    ActionRef,
    Catalog,
    CatalogSkill,
    CancelResult,
    ExecuteRequest,
    GatewayStatus,
    PoseCatalog,
    TaskResult,
    TaskState,
    ValidateRequest,
    ValidateResult,
)

DEFAULT_TIMEOUT_SEC = 60.0
CANCEL_SETTLE_TIMEOUT_SEC = 30.0

_PARAMETER_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
_RESERVED_PARAMETER_NAMES = frozenset({"task_id", "timeout_sec"})
_UNCERTAIN_EXECUTION_CODES = frozenset(
    {
        "ROBOT_CLI_TIMEOUT",
        "ROBOT_CLI_EXIT_WITHOUT_RESULT",
        "ROBOT_CLI_INVALID_OUTPUT",
        "ROBOT_RESULT_MISSING",
        "SKILL_CANCEL_TIMEOUT",
    }
)


class RobotClientError(Exception):
    """A structured failure at the RoboFrame command boundary."""

    def __init__(self, message: str, *, code: str = "ROBOT_BOUNDARY_ERROR") -> None:
        self.code = code
        super().__init__(message)


def _parse_jsonl(stdout: str) -> dict[str, Any] | None:
    """Return the last JSON object from a CLI JSON-lines stream."""

    parsed: dict[str, Any] | None = None
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            parsed = candidate
    return parsed


class RobotClient(Protocol):
    def catalog(self) -> Catalog: ...
    def poses(self) -> PoseCatalog: ...
    def status(self) -> GatewayStatus: ...
    def validate(self, request: ValidateRequest) -> ValidateResult: ...
    def execute(self, request: ExecuteRequest) -> TaskResult: ...
    def query(self, task_id: str) -> TaskResult | None: ...
    def cancel(self, task_id: str) -> CancelResult: ...


class RobotSkillCliClient:
    """Thin adapter over RoboFrame HEAD's ``robot-skill`` command contract."""

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

    def _run(
        self,
        args: list[str],
        timeout: float = DEFAULT_TIMEOUT_SEC,
        *,
        require_result_event: bool = False,
    ) -> dict[str, Any]:
        cmd = [self._bin, *self._config_args, *args]
        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RobotClientError(
                f"robot-skill exceeded the {timeout:g}s process deadline",
                code="ROBOT_CLI_TIMEOUT",
            ) from exc
        except OSError as exc:
            raise RobotClientError(
                f"robot-skill invocation failed: {exc}",
                code="ROBOT_CLI_INVOCATION_FAILED",
            ) from exc

        parsed = _parse_jsonl(completed.stdout)
        if require_result_event and _is_result_event(parsed):
            return dict(parsed["data"])

        if parsed is not None and parsed.get("ok") is False:
            raise _error_from_envelope(parsed)

        if completed.returncode != 0:
            detail = completed.stderr.strip() or f"exit {completed.returncode}"
            raise RobotClientError(
                f"robot-skill exited without a terminal result: {detail}",
                code="ROBOT_CLI_EXIT_WITHOUT_RESULT",
            )

        if parsed is None:
            raise RobotClientError(
                f"robot-skill returned non-JSON output: {completed.stdout[:200]!r}",
                code="ROBOT_CLI_INVALID_OUTPUT",
            )

        if require_result_event:
            raise RobotClientError(
                "robot-skill execute ended without a result event",
                code="ROBOT_RESULT_MISSING",
            )

        data = parsed.get("data")
        return data if isinstance(data, dict) else parsed

    def catalog(self) -> Catalog:
        listing = self._run(["list-skills"])
        robot_name = _required_string(
            listing.get("robot_name"), "list-skills.robot_name"
        )
        config_digest = _required_string(
            listing.get("config_digest"), "list-skills.config_digest"
        )
        raw_skills = _required_list(listing.get("skills"), "list-skills.skills")

        skills: list[CatalogSkill] = []
        names: set[str] = set()
        for index, raw_skill in enumerate(raw_skills):
            summary = _required_dict(raw_skill, f"list-skills.skills[{index}]")
            name = _required_string(
                summary.get("name"), f"list-skills.skills[{index}].name"
            )
            if name in names:
                raise RobotClientError(
                    f"list-skills contains duplicate skill: {name}",
                    code="CATALOG_SHAPE_INVALID",
                )
            names.add(name)

            detail = self._run(["describe", name])
            _verify_catalog_identity(
                detail, robot_name, config_digest, f"describe {name}"
            )
            detail_name = _required_string(detail.get("name"), f"describe {name}.name")
            if detail_name != name:
                raise RobotClientError(
                    f"describe returned a different skill name: {name}",
                    code="CATALOG_CHANGED_DURING_READ",
                )
            list_schema = _required_positive_int(
                summary.get("contract_schema_version"),
                f"list-skills.skills[{index}].contract_schema_version",
            )
            detail_schema = _required_positive_int(
                detail.get("schema_version"), f"describe {name}.schema_version"
            )
            if detail_schema != list_schema:
                raise RobotClientError(
                    f"skill schema changed while reading catalog: {name}",
                    code="CATALOG_CHANGED_DURING_READ",
                )

            merged = {**summary, **detail}
            merged["contract_schema_version"] = detail_schema
            merged.pop("schema_version", None)
            merged.pop("robot_name", None)
            try:
                skills.append(CatalogSkill.model_validate(merged))
            except ValidationError as exc:
                raise RobotClientError(
                    f"describe {name} returned an invalid skill contract: {exc}",
                    code="CATALOG_SHAPE_INVALID",
                ) from exc

        pose_data = self._run(["list-poses"])
        _verify_catalog_identity(pose_data, robot_name, config_digest, "list-poses")
        poses = _required_string_list(pose_data.get("poses"), "list-poses.poses")
        return Catalog(
            robot_name=robot_name,
            config_digest=config_digest,
            skills=skills,
            primitives=[],
            poses=poses,
        )

    def poses(self) -> PoseCatalog:
        return PoseCatalog.model_validate(self._run(["list-poses"]))

    def status(self) -> GatewayStatus:
        return GatewayStatus.model_validate(self._run(["status"]))

    def validate(self, request: ValidateRequest) -> ValidateResult:
        try:
            args = [
                _action_command("validate", request.action),
                request.action.name,
                *_param_flags(request.params),
            ]
            data = self._run(args)
        except RobotClientError as exc:
            return ValidateResult(valid=False, error_code=exc.code, message=str(exc))

        allowed = data.get("allowed")
        if not isinstance(allowed, bool):
            return ValidateResult(
                valid=False,
                error_code="ROBOT_RESULT_SHAPE_INVALID",
                message="robot-skill validate result is missing boolean allowed",
            )
        reason = str(data.get("reason") or "")
        error_code = str(data.get("error_code") or "")
        if not allowed and not error_code:
            error_code = "VALIDATION_REJECTED"
        return ValidateResult(valid=allowed, error_code=error_code, message=reason)

    def execute(self, request: ExecuteRequest) -> TaskResult:
        try:
            args = [
                _action_command("execute", request.action),
                request.action.name,
                "--task-id",
                request.task_id,
                *_param_flags(request.params),
            ]
            if request.timeout_sec is not None:
                args += ["--timeout-sec", str(request.timeout_sec)]
            data = self._run(
                args,
                timeout=_execute_timeout(request),
                require_result_event=True,
            )
        except RobotClientError as exc:
            state = _execution_error_state(exc.code)
            return TaskResult(
                task_id=request.task_id,
                action=request.action,
                state=state,
                success=False if state in {"failed", "canceled"} else None,
                error_code=exc.code,
                message=str(exc),
            )
        return _task_result(data, request.task_id, request.action)

    def query(self, task_id: str) -> TaskResult | None:
        return None

    def cancel(self, task_id: str) -> CancelResult:
        try:
            data = self._run(
                ["cancel", "--task-id", task_id],
                timeout=CANCEL_SETTLE_TIMEOUT_SEC,
            )
        except RobotClientError as exc:
            return CancelResult(
                task_id=task_id,
                requested=False,
                state="unknown",
                message=f"{exc.code}: {exc}",
            )
        return _cancel_result(data, task_id)


def _param_flags(params: dict[str, Any]) -> list[str]:
    flags: list[str] = []
    for key, value in params.items():
        if key in _RESERVED_PARAMETER_NAMES:
            raise RobotClientError(
                f"{key} is a request field, not an action parameter",
                code="INVALID_ACTION_PARAMS",
            )
        if _PARAMETER_NAME.fullmatch(key) is None:
            raise RobotClientError(
                f"invalid action parameter name: {key}",
                code="INVALID_ACTION_PARAMS",
            )
        try:
            if isinstance(value, bool):
                rendered = "true" if value else "false"
            elif isinstance(value, (dict, list)):
                rendered = json.dumps(
                    value,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                )
            elif value is None:
                rendered = "null"
            else:
                rendered = str(value)
        except (TypeError, ValueError) as exc:
            raise RobotClientError(
                f"action parameter {key} is not JSON encodable",
                code="INVALID_ACTION_PARAMS",
            ) from exc
        flags += [f"--{key.replace('_', '-')}", rendered]
    return flags


def _execute_timeout(request: ExecuteRequest) -> float:
    base = request.timeout_sec or DEFAULT_TIMEOUT_SEC
    return base + 30.0


def _task_result(data: dict[str, Any], task_id: str, action: ActionRef) -> TaskResult:
    success = data.get("success")
    error_code = str(data.get("error_code") or "")
    message = str(data.get("message") or "")

    if success is True and not error_code:
        state: TaskState = "completed"
        normalized_success: bool | None = True
    elif success is False and error_code == "SKILL_CANCELLED":
        state = "canceled"
        normalized_success = False
    elif success is False and error_code == "SKILL_CANCEL_TIMEOUT":
        state = "unknown"
        normalized_success = None
    elif success is False:
        state = "failed"
        normalized_success = False
        if not error_code:
            error_code = "ROBOT_EXECUTION_FAILED"
    else:
        state = "unknown"
        normalized_success = None
        if not error_code:
            error_code = "ROBOT_RESULT_SHAPE_INVALID"
        if not message:
            message = "robot-skill result is missing boolean success"

    step_count = data.get("executed_step_count", 0)
    if (
        isinstance(step_count, bool)
        or not isinstance(step_count, int)
        or step_count < 0
    ):
        state = "unknown"
        normalized_success = None
        error_code = "ROBOT_RESULT_SHAPE_INVALID"
        message = "robot-skill result has invalid executed_step_count"
        step_count = 0

    return TaskResult(
        task_id=task_id,
        action=action,
        state=state,
        success=normalized_success,
        error_code=error_code,
        message=message,
        executed_step_count=step_count,
    )


def _cancel_result(data: dict[str, Any], task_id: str) -> CancelResult:
    response_task_id = data.get("task_id")
    if response_task_id != task_id:
        return CancelResult(
            task_id=task_id,
            requested=False,
            state="unknown",
            message="robot-skill cancel returned a different task_id",
        )
    already_terminal = data.get("already_terminal")
    status = data.get("status")
    if not isinstance(already_terminal, bool) or not isinstance(status, dict):
        return CancelResult(
            task_id=task_id,
            requested=False,
            state="unknown",
            message="robot-skill cancel result has an invalid shape",
        )

    request_state = status.get("request_state")
    cancel_data = data.get("cancel")
    accepted = (
        cancel_data.get("accepted")
        if isinstance(cancel_data, dict)
        and isinstance(cancel_data.get("accepted"), bool)
        else False
    )
    message = (
        str(cancel_data.get("message") or "") if isinstance(cancel_data, dict) else ""
    )

    if already_terminal:
        return CancelResult(
            task_id=task_id,
            requested=False,
            state="unknown",
            message="task is terminal but robot-skill did not return its outcome",
        )
    if request_state == "active":
        return CancelResult(
            task_id=task_id,
            requested=accepted,
            state="running",
            message=message,
        )
    if request_state == "terminal":
        return CancelResult(
            task_id=task_id,
            requested=accepted,
            state="unknown",
            message=message
            or "task stopped; terminal outcome is pending execution result",
        )
    return CancelResult(
        task_id=task_id,
        requested=accepted,
        state="unknown",
        message=message or "robot-skill cancel status is indeterminate",
    )


def _action_command(operation: str, action: ActionRef) -> str:
    if action.kind != "skill":
        raise RobotClientError(
            "RoboFrame robot-skill CLI does not expose primitive commands",
            code="UNSUPPORTED_ACTION_KIND",
        )
    return operation


def _execution_error_state(error_code: str) -> TaskState:
    if error_code == "SKILL_CANCELLED":
        return "canceled"
    if error_code in _UNCERTAIN_EXECUTION_CODES:
        return "unknown"
    return "failed"


def _is_result_event(value: dict[str, Any] | None) -> bool:
    return (
        isinstance(value, dict)
        and value.get("event") == "result"
        and isinstance(value.get("data"), dict)
    )


def _error_from_envelope(envelope: dict[str, Any]) -> RobotClientError:
    error = envelope.get("error")
    if not isinstance(error, dict):
        return RobotClientError("unknown robot-skill error", code="ROBOT_ERROR")
    code = str(error.get("code") or "ROBOT_ERROR")
    message = str(error.get("message") or "unknown robot-skill error")
    return RobotClientError(message, code=code)


def _required_dict(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RobotClientError(
            f"{field} must be an object", code="CATALOG_SHAPE_INVALID"
        )
    return value


def _required_list(value: object, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise RobotClientError(
            f"{field} must be an array", code="CATALOG_SHAPE_INVALID"
        )
    return value


def _required_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise RobotClientError(
            f"{field} must be a non-empty string", code="CATALOG_SHAPE_INVALID"
        )
    return value


def _required_positive_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise RobotClientError(
            f"{field} must be a positive integer", code="CATALOG_SHAPE_INVALID"
        )
    return value


def _required_string_list(value: object, field: str) -> list[str]:
    items = _required_list(value, field)
    result: list[str] = []
    for index, item in enumerate(items):
        result.append(_required_string(item, f"{field}[{index}]"))
    return result


def _verify_catalog_identity(
    data: dict[str, Any], robot_name: str, config_digest: str, command: str
) -> None:
    observed_robot = _required_string(data.get("robot_name"), f"{command}.robot_name")
    observed_digest = _required_string(
        data.get("config_digest"), f"{command}.config_digest"
    )
    if observed_robot != robot_name or observed_digest != config_digest:
        raise RobotClientError(
            f"catalog changed while reading {command}",
            code="CATALOG_CHANGED_DURING_READ",
        )


def quote_for_log(args: list[str]) -> str:
    return " ".join(shlex.quote(arg) for arg in args)

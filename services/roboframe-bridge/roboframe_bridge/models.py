"""Versioned HTTP models for the RoboFrame action and task contracts."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field

ActionKind = Literal["skill", "primitive"]
TaskState = Literal["accepted", "running", "completed", "failed", "canceled", "unknown"]

TERMINAL_STATES: frozenset[str] = frozenset(
    {"completed", "failed", "canceled", "unknown"}
)
CONFIRMED_STATES: frozenset[str] = frozenset({"completed", "failed", "canceled"})


class ActionRef(BaseModel):
    """A discriminated reference to one catalog action."""

    model_config = ConfigDict(extra="forbid")

    kind: ActionKind
    name: str = Field(min_length=1, max_length=128)


class CatalogCapability(BaseModel):
    name: str
    contract_schema_version: int = Field(default=1, ge=1)
    summary: str = ""
    domain: str = ""
    moves_robot: bool = True
    required_control_mode: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)
    recovery_policy: str = ""
    timeout_policy: dict[str, Any] = Field(default_factory=dict)
    timeout_sec: float | None = Field(default=None, gt=0)
    config_digest: str = ""


class CatalogSkill(CatalogCapability):
    kind: Literal["skill"] = "skill"


class CatalogPrimitive(CatalogCapability):
    kind: Literal["primitive"] = "primitive"


class Catalog(BaseModel):
    robot_name: str
    config_digest: str
    skills: list[CatalogSkill] = Field(default_factory=list)
    primitives: list[CatalogPrimitive] = Field(default_factory=list)
    poses: list[str] = Field(default_factory=list)


class PoseCatalog(BaseModel):
    robot_name: str
    config_digest: str
    poses: list[str]


class GatewayCapabilityStatus(BaseModel):
    """One capability readiness entry returned by RoboFrame's status service."""

    model_config = ConfigDict(extra="forbid")

    name: str
    semantic_level: str
    planner_visible: bool
    ready: bool
    reason: str
    required_control_mode: str


class GatewayStatus(BaseModel):
    """Exact public ``robot-skill status`` payload at the pinned RoboFrame baseline."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(ge=1)
    robot_name: str
    motion_authorized: bool
    active_control_mode: str
    busy: bool
    active_task_id: str
    default_skill_timeout_sec: float = Field(gt=0)
    task_budget_sec: float = Field(gt=0)
    rpc_timeout_sec: float = Field(gt=0)
    config_digest: str
    capability_digest: str
    registry_epoch: str
    registry_generation: int = Field(ge=0)
    registry_digest: str
    primitive_contract_digest: str
    source_release_digest: str
    provenance_digest: str
    control_plane_ready: bool
    control_plane_state: str
    control_plane_error_code: str
    request_state: str
    request_error_code: str
    capabilities: list[GatewayCapabilityStatus]


class ValidateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: ActionRef
    params: dict[str, Any] = Field(default_factory=dict)


class ValidateResult(BaseModel):
    valid: bool
    error_code: str = ""
    message: str = ""


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1, max_length=128)
    action: ActionRef
    params: dict[str, Any] = Field(default_factory=dict)
    timeout_sec: float | None = Field(default=None, gt=0)
    context: dict[str, Any] = Field(default_factory=dict)


class ExecuteAccepted(BaseModel):
    accepted: Literal[True] = True
    task_id: str
    action: ActionRef
    state: Literal["accepted"] = "accepted"


class TaskResult(BaseModel):
    task_id: str
    action: ActionRef
    state: TaskState
    success: bool | None = None
    error_code: str = ""
    message: str = ""
    executed_step_count: int = Field(default=0, ge=0)
    context: dict[str, Any] = Field(default_factory=dict)
    accepted_at: datetime | None = None
    started_at: datetime | None = None
    updated_at: datetime | None = None
    finished_at: datetime | None = None
    cancel_requested: bool = False

    @computed_field
    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES


class CancelResult(BaseModel):
    task_id: str
    requested: bool
    state: TaskState
    message: str = ""

    @computed_field
    @property
    def confirmed(self) -> bool:
        return self.state in CONFIRMED_STATES


class Health(BaseModel):
    status: str = "ok"
    service: str = "roboframe-bridge"
    version: str

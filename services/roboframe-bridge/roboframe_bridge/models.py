"""Pydantic models mirroring the robot-skill CLI / ROS contracts."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class CatalogSkill(BaseModel):
    name: str
    summary: str = ""
    domain: str = ""
    moves_robot: bool = True
    required_control_mode: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)
    recovery_policy: str = ""
    timeout_policy: dict[str, Any] = Field(default_factory=dict)


class Catalog(BaseModel):
    robot_name: str
    config_digest: str
    skills: list[CatalogSkill]


class PoseCatalog(BaseModel):
    robot_name: str
    config_digest: str
    poses: list[str]


class GatewayStatus(BaseModel):
    motion_authorized: bool
    active_control_mode: str = ""
    required_control_mode: str = ""
    busy: bool = False
    active_task_id: str = ""
    readiness: dict[str, Any] = Field(default_factory=dict)
    ledger: dict[str, Any] = Field(default_factory=dict)


class ValidateRequest(BaseModel):
    skill: str
    params: dict[str, Any] = Field(default_factory=dict)


class ValidateResult(BaseModel):
    valid: bool
    error_code: str = ""
    message: str = ""


class ExecuteRequest(BaseModel):
    task_id: str = Field(min_length=1, max_length=128)
    skill: str
    params: dict[str, Any] = Field(default_factory=dict)
    timeout_sec: float | None = Field(default=None, gt=0)


class ExecuteAccepted(BaseModel):
    accepted: bool = True
    task_id: str
    skill: str


class TaskResult(BaseModel):
    task_id: str
    skill: str
    state: str  # planned | executing | completed | failed | canceled | unknown
    success: bool | None = None
    error_code: str = ""
    message: str = ""
    executed_primitives: list[str] = Field(default_factory=list)


class CancelResult(BaseModel):
    task_id: str
    requested: bool
    state: str
    message: str = ""


class Health(BaseModel):
    status: str = "ok"
    service: str = "roboframe-bridge"
    version: str

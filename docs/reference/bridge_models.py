# 这份文件是**抄来的**，不是我们写的。
#
# 出处：roboframe-bridge（旧仓库 services/roboframe-bridge），路径 `roboframe_bridge/models.py`，
#       commit 561f75f9（"feat(roboframe): add HTTP bridge service over robot-skill boundary"）。
# 抄什么：**只有 models 那一层**（pydantic 类），逐字照抄；`app.py`（FastAPI 端点实现）不抄
#       —— 我们要的是形状的判据，不是端点的实现。
# 为什么抄：形状的判据必须是 **bridge 自己那一份**，不能由我们凭接口文档再写一遍。
#       `docs/reference/task_protocol.py` 是同一个做法。`packages/robot-bridge/test/model-parity.test.ts`
#       就是拿这份文件（pydantic 亲自跑）来验我们编出来的请求。
# 不变性：上游改了这份文件，这里**不会自己跟着变**。要重新抄一次，并改上面那个 commit。
#
# 下面一行起是上游原文，一个字没动。

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

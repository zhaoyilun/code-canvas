"""Thread-safe active task registry with bounded terminal history."""

from __future__ import annotations

import threading
from collections import OrderedDict
from datetime import datetime, timezone

from .models import CONFIRMED_STATES, TERMINAL_STATES, ExecuteRequest, TaskResult

DEFAULT_CAPACITY = 256


class TaskConflict(Exception):
    """Raised when an accepted task ID is submitted again."""

    def __init__(self, existing: TaskResult) -> None:
        self.existing = existing
        super().__init__(f"task_id already exists: {existing.task_id}")


class TaskRegistry:
    """Keep every active task plus the most recent terminal task records."""

    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        if capacity < 1:
            raise ValueError("capacity must be positive")
        self._lock = threading.Lock()
        self._capacity = capacity
        self._tasks: OrderedDict[str, TaskResult] = OrderedDict()

    def accept(self, request: ExecuteRequest) -> TaskResult:
        """Atomically reserve a task ID and create its accepted record."""
        now = _now()
        accepted = TaskResult(
            task_id=request.task_id,
            action=request.action,
            state="accepted",
            context=request.context,
            accepted_at=now,
            updated_at=now,
        )
        with self._lock:
            existing = self._tasks.get(request.task_id)
            if existing is not None:
                raise TaskConflict(existing.model_copy(deep=True))
            self._tasks[request.task_id] = accepted
            self._trim_terminal_history()
            return accepted.model_copy(deep=True)

    def mark_running(self, task_id: str) -> TaskResult | None:
        """Move an accepted task to running unless it already has a terminal result."""
        now = _now()
        with self._lock:
            current = self._tasks.get(task_id)
            if current is None:
                return None
            if current.state in TERMINAL_STATES:
                return current.model_copy(deep=True)
            if current.state == "accepted":
                current = current.model_copy(
                    update={"state": "running", "started_at": now, "updated_at": now}
                )
                self._store(current)
            return current.model_copy(deep=True)

    def mark_cancel_requested(self, task_id: str) -> TaskResult | None:
        now = _now()
        with self._lock:
            current = self._tasks.get(task_id)
            if current is None:
                return None
            if not current.cancel_requested:
                current = current.model_copy(
                    update={"cancel_requested": True, "updated_at": now}
                )
                self._store(current)
            return current.model_copy(deep=True)

    def record(self, result: TaskResult) -> TaskResult:
        """Merge an observed state while preserving registry-owned task metadata."""
        now = _now()
        with self._lock:
            current = self._tasks.get(result.task_id)
            if current is None:
                accepted_at = result.accepted_at or now
                finished_at = result.finished_at
                if result.state in TERMINAL_STATES and finished_at is None:
                    finished_at = now
                stored = result.model_copy(
                    update={
                        "accepted_at": accepted_at,
                        "updated_at": now,
                        "finished_at": finished_at,
                    }
                )
                self._store(stored)
                self._trim_terminal_history()
                return stored.model_copy(deep=True)

            if _keeps_current_state(current, result):
                return current.model_copy(deep=True)

            finished_at = current.finished_at
            if result.state in TERMINAL_STATES:
                finished_at = result.finished_at or now

            stored = current.model_copy(
                update={
                    "action": current.action,
                    "state": result.state,
                    "success": result.success,
                    "error_code": result.error_code,
                    "message": result.message,
                    "executed_step_count": result.executed_step_count,
                    "context": current.context,
                    "started_at": current.started_at or result.started_at,
                    "updated_at": now,
                    "finished_at": finished_at,
                    "cancel_requested": current.cancel_requested
                    or result.cancel_requested,
                }
            )
            self._store(stored)
            self._trim_terminal_history()
            return stored.model_copy(deep=True)

    def get(self, task_id: str) -> TaskResult | None:
        with self._lock:
            result = self._tasks.get(task_id)
            return None if result is None else result.model_copy(deep=True)

    def _store(self, result: TaskResult) -> None:
        self._tasks[result.task_id] = result
        self._tasks.move_to_end(result.task_id)

    def _trim_terminal_history(self) -> None:
        terminal_ids = [
            task_id
            for task_id, task in self._tasks.items()
            if task.state in TERMINAL_STATES
        ]
        for task_id in terminal_ids[: -self._capacity]:
            del self._tasks[task_id]


def _keeps_current_state(current: TaskResult, incoming: TaskResult) -> bool:
    if current.state in CONFIRMED_STATES:
        return incoming.state != current.state or incoming.state not in CONFIRMED_STATES
    if current.state == "unknown":
        return incoming.state not in CONFIRMED_STATES and incoming.state != "unknown"
    if current.state == "running" and incoming.state == "accepted":
        return True
    return False


def _now() -> datetime:
    return datetime.now(timezone.utc)

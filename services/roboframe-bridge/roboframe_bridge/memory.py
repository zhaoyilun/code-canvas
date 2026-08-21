"""Bounded in-memory registry of task terminal states.

The bridge is near-stateless by design: executions are delegated to
`robot-skill`, and this registry only remembers recent terminal results so
`GET /v1/tasks/{id}` keeps working after the CLI process exits. Restart loses
history by design; durable records live in n8n execution history.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

from .models import TaskResult

DEFAULT_CAPACITY = 256


class TaskRegistry:
    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        self._lock = threading.Lock()
        self._capacity = capacity
        self._tasks: OrderedDict[str, TaskResult] = OrderedDict()

    def record(self, result: TaskResult) -> None:
        with self._lock:
            self._tasks[result.task_id] = result
            self._tasks.move_to_end(result.task_id)
            while len(self._tasks) > self._capacity:
                self._tasks.popitem(last=False)

    def get(self, task_id: str) -> TaskResult | None:
        with self._lock:
            return self._tasks.get(task_id)

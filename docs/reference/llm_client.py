"""Small Ollama client for一期任务规划测试。"""

from __future__ import annotations

import json
import os
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

from task_protocol import TaskValidationError, validate_task


SYSTEM_PROMPT = """你是RoboFrame一期机器人任务规划器。只输出合法JSON，不要输出Markdown和解释。
必须包含schema_version=\"1.0\"、task_id、description、steps数组、limits对象。
steps中的action只能是move、turn、stop、stop_if_obstacle、get_status、arm_joint、arm6_joints。
move必须包含id、linear、angular、duration；turn必须包含id、angular、duration；
stop和get_status必须包含id；stop_if_obstacle必须包含id、sensors数组和distance。
arm_joint用于单关节控制，必须包含id、joint_id(1~6)、joint(0~180)、time(100~10000毫秒)。
arm6_joints用于六关节控制，必须包含id、joint1到joint6(均为0~180)、time(100~10000毫秒)。
sensors只能使用/scan0或/scan1。默认limits为max_linear=0.3、max_angular=1.2、
max_duration=30.0、require_confirmation=true。"""


class LLMClientError(RuntimeError):
    """Raised when Ollama output cannot become a safe task."""


class LLMClient:
    def __init__(self, base_url: str | None = None, model: str | None = None, retries: int = 2, api_key: str | None = None):
        self.provider = os.getenv("LLM_PROVIDER", "ollama")
        base_url = base_url or os.getenv("LLM_BASE_URL", "http://127.0.0.1:11434")
        self.openai_compatible = self.provider != "ollama" or base_url.rstrip("/").endswith("/v1")
        self.url = base_url.rstrip("/") + ("/chat/completions" if self.openai_compatible else "/api/chat")
        self.model = model or os.getenv("LLM_MODEL", "qwen3:8b")
        self.api_key = api_key if api_key is not None else os.getenv("LLM_API_KEY", "")
        self.retries = max(1, retries)

    def generate_task(self, instruction: str) -> dict:
        if not instruction.strip():
            raise LLMClientError("instruction must not be empty")
        payload = {
            "model": self.model,
            "stream": False,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": instruction},
            ],
        }
        if self.openai_compatible:
            payload.update({"temperature": 0.1, "response_format": {"type": "json_object"}, "max_tokens": 512})
        else:
            payload.update({"think": False, "format": "json", "options": {"temperature": 0.1, "num_predict": 512}})
        request = Request(
            self.url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {})},
            method="POST",
        )
        last_error: Exception | None = None
        for attempt in range(self.retries):
            try:
                with urlopen(request, timeout=90) as response:
                    envelope = json.loads(response.read().decode("utf-8"))
                content = (envelope["choices"][0]["message"]["content"] if self.openai_compatible else envelope["message"]["content"])
                task = self._normalize_step_ids(json.loads(self._strip_code_fence(content)))
                return validate_task(task)
            except (OSError, URLError, KeyError, TypeError, json.JSONDecodeError, TaskValidationError) as exc:
                last_error = exc
                if attempt + 1 < self.retries:
                    time.sleep(0.2)
        raise LLMClientError(f"LLM response is unavailable or invalid: {last_error}") from last_error

    @staticmethod
    def _strip_code_fence(content: str) -> str:
        text = content.strip()
        if text.startswith("```") and text.endswith("```"):
            text = text[3:]
            if text.startswith("json"):
                text = text[4:]
            text = text.rstrip("`").strip()
        return text

    @staticmethod
    def _normalize_step_ids(task: object) -> object:
        """Fill only missing/blank step labels; all safety fields remain validated."""
        if not isinstance(task, dict) or not isinstance(task.get("steps"), list):
            return task
        for index, step in enumerate(task["steps"], start=1):
            if isinstance(step, dict) and (not isinstance(step.get("id"), str) or not step["id"].strip()):
                step["id"] = f"step-{index}"
        return task

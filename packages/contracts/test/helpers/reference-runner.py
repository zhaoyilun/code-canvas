"""把对照语料喂给一期协议参考实现，输出 JSON 结论。

用法：python3 reference-runner.py <cases.json> <task_protocol.py>
cases.json 是 [{ name, task, seen_task_ids? }, ...]；stdout 是同样顺序的结论数组。
参考实现是 fail-fast 的，所以只回第一处错的原文——TS 侧要求「该原文必须出现在诊断集合里」。
"""

import importlib.util
import json
import sys

# 只读参考实现：不要往 docs/ 里写 __pycache__（那是别人的目录）。
sys.dont_write_bytecode = True


def load_protocol(path):
    spec = importlib.util.spec_from_file_location("task_protocol_reference", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load protocol from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    cases_path, protocol_path = sys.argv[1], sys.argv[2]
    protocol = load_protocol(protocol_path)
    with open(cases_path, encoding="utf-8") as handle:
        cases = json.load(handle)

    results = []
    for case in cases:
        seen = case.get("seen_task_ids", [])
        try:
            validated = protocol.validate_task(case["task"], seen_task_ids=seen)
            results.append({"ok": True, "message": None, "error_type": None, "limits": validated.get("limits")})
        except Exception as error:  # noqa: BLE001 - 参考实现的崩溃也算一种结论
            results.append(
                {
                    "ok": False,
                    "message": str(error),
                    "error_type": type(error).__name__,
                    "limits": None,
                }
            )

    json.dump(results, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

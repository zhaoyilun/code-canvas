"""拿 bridge 自己的 pydantic 模型逐个 validate 一批载荷，把结论以 JSON 吐回来。

用法：<python> bridge-model-check.py <cases.json> <bridge_models.py>
cases.json 是 [{ "model": "ExecuteRequest", "payload": {...} }, ...]；
stdout 是同样顺序的结论数组：{ model, ok, error_type, error, dump }。
`dump` 是 pydantic 校验之后的 `model_dump()`（缺省值都填好了），TS 侧拿它与自己的 zod 结果对账
——两边字段名或缺省值分叉，对不上就在这里露出来。

解释器由调用方给（`BRIDGE_PYTHON`）：**pydantic 不是每台机器都有**，桥自己的 venv 里才有。
"""

import importlib.util
import json
import sys

# 只读参考实现：不要往 docs/ 里写 __pycache__（那是别人的目录）。
sys.dont_write_bytecode = True


def load_models(path):
    spec = importlib.util.spec_from_file_location("bridge_models_reference", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load bridge models from {path}")
    module = importlib.util.module_from_spec(spec)
    # 必须先挂进 sys.modules 再 exec：那份文件带 `from __future__ import annotations`
    # （注解是字符串），pydantic 解析 `dict[str, Any]` 这类前向引用时要回这个模块的命名空间里找
    # ——不挂进去就报 "not fully defined; you should define `Any`"。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    cases_path, models_path = sys.argv[1], sys.argv[2]
    models = load_models(models_path)
    with open(cases_path, encoding="utf-8") as handle:
        cases = json.load(handle)

    results = []
    for case in cases:
        name = case["model"]
        model = getattr(models, name, None)
        if model is None:
            results.append(
                {
                    "model": name,
                    "ok": False,
                    "error_type": "UnknownModel",
                    "error": f"bridge_models.py 里没有 {name}",
                    "dump": None,
                }
            )
            continue
        try:
            validated = model.model_validate(case["payload"])
            results.append(
                {
                    "model": name,
                    "ok": True,
                    "error_type": None,
                    "error": None,
                    "dump": validated.model_dump(),
                }
            )
        except Exception as error:  # noqa: BLE001 - pydantic 的 ValidationError 与任何崩溃都算一种结论
            results.append(
                {
                    "model": name,
                    "ok": False,
                    "error_type": type(error).__name__,
                    "error": str(error),
                    "dump": None,
                }
            )

    json.dump(results, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

/**
 * 技能计划 → RoboFrame bridge 的调用序列。
 *
 * 两个东西容易混，这里说清：
 * - `models.ts` 是 **bridge 的形状**（`docs/reference/bridge_models.py` 的 zod 镜像，逐字对应）；
 * - `compile.ts` 是 **我们的编译**（计划 → 一列调用，声明式，不发请求），
 *   其中「哪一类步去哪儿」那份清单在 `limits.ts`。
 *
 * 判据是 bridge 自己的 pydantic 模型：`test/model-parity.test.ts` 把编出来的请求交给
 * `docs/reference/bridge_models.py` 逐个 validate，两边结论必须一致。
 */
export * from './models';
export * from './limits';
export * from './compile';

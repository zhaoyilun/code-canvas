# CodeCanvas

面向设备编排的可视化编程工作台。选一台设备，说一句人话，看着它变成机器真会执行的代码。

- 入口：**选设备 + 一句话 → 生成任务 JSON**
- 同一份声明同时呈现为四个视图：**流程画布** / **积木画布** / **代码面板** / **任务 JSON**
- 流程画布上的一个模块 = 一个**能力**（函数调用点）；点开它，积木与代码显示的是它的**实现**
  （函数体）——机器为了执行它具体调了哪些接口、按什么顺序、带什么参数
- 任务本身能**分叉**（`if last.success` 成没成，两条臂）、能**停一下**（`wait`）、
  也能声明某一步**失败也往下走**（`onFailure: "continue"`，缺省仍是停）
- 选「虚拟设备」时，当前任务会在右栏的 **3D 机械臂**上真的跑一遍；跑到哪一步，
  流程画布上那一步就亮，积木与代码面板跟着切过去

设计与格式见 [docs/spec.md](docs/spec.md)。

## 目录是真的

`packages/capabilities/src/roboframe/` 里的技能目录**不是手写的**，由
`tools/import-roboframe/import.mjs` 从上游 RoboFrame 仓库机械转出：

```bash
ROBOFRAME_SRC=/path/to/IB_Robot node tools/import-roboframe/import.mjs
```

上游是 `gitcode.com/openeuler/IB_Robot` 的 `RoboFrame` 分支。转出来的是 16 个技能、
`skill_library` 的 10 个原语白名单、命名位姿与中文别名，每个技能的
`primitive_sequence` 就是它的实现。转换脚本读不懂的地方当场报错，不猜；
`provenance` 里记着是哪一次 commit。

## 跑起来

```bash
pnpm install
pnpm --filter @codecanvas/studio dev      # http://localhost:5173
```

「生成」要调 LLM：dev server 把 `/llm/*` 反代到 LLM 服务并在**服务端**注入 key，
所以 key 从不进浏览器。取 `LLM_API_KEY`，退到 `DEEPSEEK_API_KEY`；地址取 `LLM_BASE_URL`，
退到 DeepSeek。

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm --filter @codecanvas/studio dev
```

## 测

```bash
pnpm -r test
pnpm -r typecheck
```

## 状态

能用：一句话生成任务、四个视图联动、任务层分支与等待、在虚拟设备上执行并逐步跟随。

没有：真机连接（没有硬件；虚拟设备走的是同一个执行器）、感知条件（得先有会报那个量的技能）、
审批与回放。逐条列在 [docs/plan.md](docs/plan.md) 末尾的「还没做的」表里，**每条都写了为什么**。

旧实现是基于 n8n 的 fork，保留在 `../code-canvas` 作参考，本仓库不含它的源码。

## 应用

- `apps/studio` —— 编排工作台：三个视图（流程 / 积木 / 代码）看同一份声明。
- `apps/robot3d` —— RoboFrame 能力目录的 3D 执行器：把设备会做什么跑给你看，逐步对账。

## 许可

Apache-2.0

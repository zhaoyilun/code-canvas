# 教育通用边界检查

`verify-generic-boundary.mjs` 用一条可重复命令确认教育分支仍是领域无关的双画布宿主：

```bash
node scripts/education/verify-generic-boundary.mjs
node --test scripts/education/verify-generic-boundary.test.mjs
```

检查范围严格限定为本项目增加的生产代码、相关 `package.json` 和项目工作流夹具。上游测试、`node_modules`、`dist`、`.pack` 以及用于解释边界的 `docs/education` 不参与文本扫描。

脚本检查五组旧实现已经退出主仓：领域社区节点、领域 Blockly/生成器、硬件 bridge、设备部署、领域交付材料；同时检查生产代码与 manifest 不再引用旧领域契约，并要求项目生成的工作流使用已安装包提供的标准节点类型，而不是临时类型名。

## 通用双画布端到端示例

`generic-dual-canvas-example.mjs` 使用已构建的 TypeScript importer、dual-canvas core 和
data-transform compiler，把纯通用 TypeScript 转换函数生成成可审计的双画布 JSON：

```bash
node scripts/education/generic-dual-canvas-example.mjs
node --test scripts/education/generic-dual-canvas-example.test.mjs
```

输入为 `docs/education/examples/generic-score-normalizer.ts`，确定性输出为
`docs/education/examples/generic-score-normalizer.dual-canvas.json`。验收覆盖
`VisualProgramIRV1`、实际安装节点名的工作流片段、Blockly payload 编译、完整源码映射、
JSON 往返、字节稳定性以及独立的通用运行时依赖闭包。

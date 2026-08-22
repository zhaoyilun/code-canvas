# Blockly Data Transform v1 本地验收运行手册

## 目的与边界

本资产验证三个真实业务订单的一对一转换：保留原始客户对象并生成 `customerLabel`，计算 `amount * quantity` 为 `orderTotal`，按 `100` 阈值写入 `grade`。不提供密码、token、cookie、`.env` 读取或写入能力。

`payload.workspace` 是唯一业务源；`payload.javascript` 仅是共享编译器生成的只读预览缓存。编辑中的非法 workspace 可以保存空预览，但正式验收 fixture 必须由共享编译器刷新为 canonical 预览；不得手写 JavaScript 代替编译结果。运行时始终重新编译 workspace，而不信任该预览缓存。

## 构建与本地静态验证

在仓库根目录执行（构建输出按项目规则重定向）：

```bash
pnpm --filter @n8n/blockly-data-transform build > scripts/blockly-v1/.runtime/shared-compiler-build.log 2>&1
pnpm --filter n8n-nodes-blockly-code build > scripts/blockly-v1/.runtime/custom-node-build.log 2>&1
node scripts/blockly-v1/verify-v1.mjs --require-compiler --refresh-preview
node scripts/blockly-v1/verify-v1.mjs --require-compiler
scripts/blockly-v1/setup-demo.sh --check
scripts/blockly-v1/check-package-contents.sh
```

若共享包的构建入口不在默认 `packages/@n8n/blockly-data-transform/dist/index.js`，仅在当前 shell 设置非敏感路径变量后运行：

```bash
N8N_BLOCKLY_COMPILER_MODULE=/absolute/path/to/index.js node scripts/blockly-v1/verify-v1.mjs --require-compiler --refresh-preview
```

刷新会且只会改写该 fixture 的 `payload.javascript` 为 `compileBlocklyWorkspace(workspace)` 的 canonical 输出；不会复制或执行编译逻辑。

## 隔离实例、人工登录与导入

1. 不要停止或改动当前正在运行的 n8n 服务。选择一个未被占用的端口后，由主会话在其启动 shell 设置非敏感 `N8N_PORT`；本脚本不设置端口。
2. 导入到隔离目录（运行时 DB 和日志只会写入 `scripts/blockly-v1/.runtime/`）：

   ```bash
   scripts/blockly-v1/setup-demo.sh --import
   N8N_RUNNERS_INSECURE_MODE=false scripts/blockly-v1/run-demo.sh
   ```

3. 在浏览器打开启动输出的 URL。用户必须在浏览器手工完成 owner 登录/设置；不得将密码写到命令、日志、截图或仓库文件。
4. 导入 **Blockly Data Transform v1 — Three Orders**。画布路径必须是 Manual Trigger → Seed three business orders → Split orders into three items → Blockly Data Transform。

## UI 业务验收与证据

在真实 UI 中完成并留存脱敏截图或日志：

1. 节点创建器搜索并添加 **Blockly Data Transform**；截图显示可见入口。
2. 打开节点，确认 schema URL `/schemas/CUSTOM.blocklyCode/1.0.0.json` 返回 HTTP 200，并另行截图/记录响应。此 HTTP 200 **不等于业务 PASS**。
3. 确认 Blockly 工作区包含字段标准化、金额乘法和条件分级；预览只读，且与 `verify-v1.mjs --require-compiler` 的 canonical 输出一致。
4. 编辑一个可识别的文本块，再保存；记录正常 workflow PATCH 成功。重新加载后 workspace 仍存在。
5. 执行 workflow；执行记录必须为 `success`，Blockly 节点输出必须恰好三项、顺序不变，并与 `scripts/blockly-v1/fixtures/expected-output.json` 字段完全一致。
6. 通过官方 UI/CLI 导出 workflow；对导出文件运行 `node scripts/blockly-v1/verify-v1.mjs /path/to/export.json --require-compiler`。将该文件导入新的隔离 `N8N_USER_FOLDER`，用 `n8n execute --id=<imported-id> --rawOutput` 保存结果，再运行 `node scripts/blockly-v1/verify-execution.mjs /path/to/raw-output.json`；必须得到相同三项输出。此 `--rawOutput` 只证明输出验收，不能证明 preview tamper 信任边界。

静态验证、单元测试或 health/HTTP 200 都不能替代上述真实 UI 保存、重载、执行、导出/导入和证据留存。

## Secure runner 与 preview 信任边界

发布证据必须使用 secure JavaScript task runner。启动时显式保持 `N8N_RUNNERS_INSECURE_MODE=false`，并在另一个终端记录 runner 进程参数：

```bash
ps -axww -o pid=,ppid=,command= \
  | grep '/packages/@n8n/task-runner/dist/start.js' \
  | grep -v grep
```

输出必须同时包含 `--disallow-code-generation-from-strings` 和 `--disable-proto=delete`，启动日志不得出现 `TASK RUNNER CONFIGURED TO START IN INSECURE MODE`。Instance AI 的 `Sandbox: enabled=...` 日志与 JavaScript task runner 模式无关，不能作为此项证据。

后端不信任 preview 的运行时验收使用正式 UI 导出文件的副本，不改 workspace，只改 `payload.javascript`：

```bash
export EXPORTED_WORKFLOW=/path/to/ui-exported.json
export TAMPER_RUNTIME=scripts/blockly-v1/.runtime/tampered-preview
mkdir -p "$TAMPER_RUNTIME"
export TAMPER_RUNTIME="$(cd "$TAMPER_RUNTIME" && pwd)"

node - "$EXPORTED_WORKFLOW" "$TAMPER_RUNTIME/workflow.json" <<'NODE'
const fs = require('node:fs');
const workflow = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
workflow.id = `${workflow.id}-tampered-preview`;
const node = workflow.nodes.find(({ type }) => type === 'CUSTOM.blocklyCode');
const payload = JSON.parse(node.parameters.blocklyPayload);
payload.javascript = 'return { json: { tampered: true } };';
node.parameters.blocklyPayload = JSON.stringify(payload);
fs.writeFileSync(process.argv[3], JSON.stringify(workflow, null, 2));
NODE

N8N_USER_FOLDER="$TAMPER_RUNTIME/n8n-user" \
N8N_CUSTOM_EXTENSIONS="$PWD/custom-nodes/n8n-nodes-blockly-code/dist" \
packages/cli/bin/n8n import:workflow --input="$TAMPER_RUNTIME/workflow.json"

# 先把 N8N_RUNNERS_BROKER_PORT 设置为一个未占用端口。
N8N_USER_FOLDER="$TAMPER_RUNTIME/n8n-user" \
N8N_CUSTOM_EXTENSIONS="$PWD/custom-nodes/n8n-nodes-blockly-code/dist" \
N8N_RUNNERS_INSECURE_MODE=false \
packages/cli/bin/n8n execute --id="$(node -p "require(process.env.TAMPER_RUNTIME + '/workflow.json').id")" \
  --rawOutput > "$TAMPER_RUNTIME/raw-output.json"

# rawOutput 只可用于常规输出验收，不能作为 tamper 证据。
node scripts/blockly-v1/verify-execution.mjs "$TAMPER_RUNTIME/raw-output.json"

# 取该次执行的完整 execution record。它必须同时包含 workflowId、workflowData
# 和 data.resultData；不要将上面的 raw-output.json 传给 tamper 验证。
export TAMPER_WORKFLOW_ID="$(node -p "require(process.env.TAMPER_RUNTIME + '/workflow.json').id")"
export N8N_SQLITE_DB="$TAMPER_RUNTIME/n8n-user/.n8n/database.sqlite"
export TAMPER_EXECUTION_ID="$(sqlite3 -readonly "$N8N_SQLITE_DB" \
  "SELECT id FROM execution_entity WHERE workflowId = '$TAMPER_WORKFLOW_ID' ORDER BY id DESC LIMIT 1;")"
test -n "$TAMPER_EXECUTION_ID"

# 从 SQLite 的 execution_entity 与 execution_data 导出同一条完整记录。
sqlite3 -readonly -json "$N8N_SQLITE_DB" "
SELECT e.id, e.workflowId, e.finished, e.mode, e.status, d.workflowData, d.data
FROM execution_entity e
JOIN execution_data d ON d.executionId = e.id
WHERE e.id = $TAMPER_EXECUTION_ID;
" > "$TAMPER_RUNTIME/execution-record-row.json"

# execution_data.data 使用 flatted 存储；在声明该现有依赖的 packages/cli
# 上下文中解码，不新增依赖。
(
  cd packages/cli
  node --input-type=module - \
    "$TAMPER_RUNTIME/execution-record-row.json" \
    "$TAMPER_RUNTIME/execution-record.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseFlatted } from 'flatted';

const [inputPath, outputPath] = process.argv.slice(2);
const [row] = JSON.parse(readFileSync(inputPath, 'utf8'));
if (!row) throw new Error('SQLite execution record was not found');
const record = {
  ...row,
  finished: Boolean(row.finished),
  workflowData: JSON.parse(row.workflowData),
  data: parseFlatted(row.data),
};
writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
NODE
)

node scripts/blockly-v1/verify-execution.mjs \
  "$TAMPER_RUNTIME/execution-record.json" \
  --workflow="$TAMPER_RUNTIME/workflow.json" \
  --expect-tampered-preview
```

tamper 模式会额外校验 `execution.workflowId` 与 `--workflow` 文档 id 一致，且 `execution.workflowData` 中唯一 `CUSTOM.blocklyCode` 节点的 `blocklyPayload` 与传入 tampered workflow 完全一致，再校验三条运行输出。只有验证器报告 tampered preview 被忽略、三条输出与 `expected-output.json` 完全一致时，该信任边界才通过。

## 停止、清理与回滚

- 在运行 `run-demo.sh` 的终端按 `Ctrl-C` 停止；先确认进程已退出，再删除 `scripts/blockly-v1/.runtime/`，仅清理本验收隔离数据。
- 回滚本 worker 资产：删除 `scripts/blockly-v1/` 与 `docs/blockly-v1/`，或用 `git restore --source=HEAD -- scripts/blockly-v1 docs/blockly-v1`（仅对已跟踪文件有效）。
- 不要删除其他 n8n 用户目录；清理范围只限本手册明确创建的隔离目录。

# n8n-blockly — 通用代码双画布教学平台（n8n fork）

> 本分支只负责教育侧的通用能力：把代码转换为同一份中间表示，并同步呈现 Blockly 逻辑画布与 n8n 工作流画布。设备适配、硬件通信和具体机器人产品均在插件或硬件交付边界内实现。以下为上游 n8n 原始 README。

## 本仓库新增内容

| 层级 | 作用 | 入口 |
| --- | --- | --- |
| **双画布核心** | 定义版本化 IR、能力目录、执行计划、映射、诊断和 Plugin SDK；核心保持领域无关 | `packages/@n8n/dual-canvas-core/` |
| **TypeScript 导入器** | 将受支持的 JavaScript、TypeScript、ArkTS 教学子集转换为 IR、Blockly 工作区和 n8n 工作流片段 | `packages/@n8n/dual-canvas-typescript-importer/` |
| **Blockly Data Transform** | 用 Blockly 编辑逐项数据变换；运行时从工作区重新编译，代码预览只用于解释 | `custom-nodes/n8n-nodes-blockly-code/`、`packages/@n8n/blockly-data-transform/` |
| **通用能力计划编辑器** | 按能力目录组织可视化计划，不在宿主中固化某个设备领域 | `packages/@n8n/blockly-capability-plan/` |

## 插件与硬件边界

RoboFrame 适配已拆到独立仓库 `n8n-dual-canvas-roboframe-plugin`。该插件负责把通用能力目录和执行计划映射到 RoboFrame 节点；设备 bridge、部署文件与设备验证证据由硬件交付边界持有。本仓库不包含这些实现，也不据此声明设备运行结果。

通用数据流为：`源代码 → TypeScript 导入器 → VisualProgramIR → Blockly 逻辑画布 + n8n 工作流画布`。两张画布共享稳定标识和源代码位置映射，领域插件只接入公开契约。

---

![Banner image](https://user-images.githubusercontent.com/10284570/173569848-c624317f-42b1-45a6-ab09-f0ea3c247648.png)

# n8n – The Platform for AI Agents and Workflow Automation

Fair-code platform to build and deploy AI agents and workflows. Combine a visual canvas with custom code, run it self-hosted or in the [cloud](https://app.n8n.cloud/login), and connect to 1500+ integrations. AI automation you can trust with real work, from prototype to production.

![n8n.io - Screenshot](https://raw.githubusercontent.com/n8n-io/n8n/master/assets/n8n-screenshot-readme.png)

## Key Capabilities

- **AI-Native Automation Platform**: Build and operationalize AI workflows and multi-step agents using your own data, models, and tools
- **Model Flexibility, No Lock-In**: Connect to OpenAI, Anthropic, Google, or open-source models and switch providers without changing your architecture
- **From Prototype to Production**: Design multi-step AI workflows with logic, tool use, human approvals, and full observability
- **Code When You Need It**: Combine visual building with JavaScript, Python, and npm packages for advanced AI workflows
- **Enterprise-Ready AI**: Self-host or deploy securely with role-based access, audit trails, and support for sensitive data
- **Leverage What Already Exists**: 1500+ integrations and 9,000+ workflow [templates](https://n8n.io/workflows) to connect AI with your existing systems

## Quick Start

Try n8n instantly with [npx](https://docs.n8n.io/hosting/installation/npm/) (requires [Node.js](https://nodejs.org/en/)):

```
npx n8n
```

Or deploy with [Docker](https://docs.n8n.io/hosting/installation/docker/):

```
docker volume create n8n_data
docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
```

Access the editor at http://localhost:5678

## Resources

- 📚 [Documentation](https://docs.n8n.io)
- 🔧 [1500+ Integrations](https://n8n.io/integrations)
- 💡 [Example Workflows](https://n8n.io/workflows)
- 🤖 [AI & LangChain Guide](https://docs.n8n.io/advanced-ai/)
- 👥 [Community Forum](https://community.n8n.io)
- 📖 [Community Tutorials](https://community.n8n.io/c/tutorials/28)

## Support

Need help? Our community forum is the place to get support and connect with other users:
[community.n8n.io](https://community.n8n.io)

## License

n8n is [fair-code](https://faircode.io) distributed under the [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) and [n8n Enterprise License](https://github.com/n8n-io/n8n/blob/master/LICENSE_EE.md).

- **Source Available**: Always visible source code
- **Self-Hostable**: Deploy anywhere
- **Extensible**: Add your own nodes and functionality

[Enterprise Licenses](mailto:license@n8n.io) available for additional features and support.

Additional information about the license model can be found in the [docs](https://docs.n8n.io/sustainable-use-license/).

## Contributing

Found a bug 🐛 or have a feature idea ✨? Check our [Contributing Guide](https://github.com/n8n-io/n8n/blob/master/CONTRIBUTING.md) for a setup guide & best practices.

## Join the Team

Want to shape the future of automation? Check out our [job posts](https://n8n.io/careers) and join our team!

## What does n8n mean?

**Short answer:** It means "nodemation" and is pronounced as n-eight-n.

**Long answer:** "I get that question quite often (more often than I expected) so I decided it is probably best to answer it here. While looking for a good name for the project with a free domain I realized very quickly that all the good ones I could think of were already taken. So, in the end, I chose nodemation. 'node-' in the sense that it uses a Node-View and that it uses Node.js and '-mation' for 'automation' which is what the project is supposed to help with. However, I did not like how long the name was and I could not imagine writing something that long every time in the CLI. That is when I then ended up on 'n8n'." - **Jan Oberhauser, Founder and CEO, n8n.io**

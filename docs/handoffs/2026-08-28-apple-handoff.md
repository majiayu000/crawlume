# Diaoyan Apple 接管说明

日期：2026-08-28

## 目标

把 Diaoyan 的完整 Git 历史、本轮可靠性设计、净化后的产品讨论记录和继续工作的入口复制到：

```text
ssh apple:/Users/apple/Desktop/code/AI/tool/sc
```

目标目录在迁移前已确认存在且为空，因此将直接作为仓库根目录，不额外嵌套 `diaoyan/`。

## 规范源

- 当前已实现合同：`docs/spec.md`
- 文档总索引：`docs/README.md`
- 产品策略：`docs/product-strategy.md`
- Reliability Benchmark：`docs/reliability-benchmark-spec.md`
- 目标架构：`docs/reliability-architecture.md`
- 研究决策和实验：`docs/reliability-exploration-log.md`
- 本轮净化聊天记录：`docs/handoffs/2026-08-28-reliability-product-conversation.md`
- 实施顺序：`docs/roadmap.md`

## 当前结论

Diaoyan 的核心目标是降低 `Cost per Valid Artifact`，不是最大化原始调用成功率，也不是优先建设
多租户、SSO、账单或控制台。

第一实施阶段必须是：

1. Case Schema。
2. Layer A Hermetic Fixtures。
3. Controlled Site。
4. 独立 Truth Evaluator。
5. Valid Result、False Success、Cost per Valid Artifact baseline。

在真值 baseline 出现前，不开始自动学习 Planner，也不宣称优于 Firecrawl、AnyCrawl 或其他竞品。

## 推荐接管顺序

```text
1. 阅读 docs/README.md
2. 阅读 docs/reliability-benchmark-spec.md
3. 阅读 docs/reliability-architecture.md 的 P0 和 Boundary Contracts
4. 运行 pnpm check && pnpm test
5. 只实现 v0.11 Reliability Truth 的最小 slice
6. 用 pnpm bench --mode pr 作为未来 P0 完成门
```

## 环境要求

- macOS / Linux。
- Node.js `>=25.7.0`，以 `package.json` 为准。
- pnpm。
- Browser 模式需要 Google Chrome。
- 不复制 `node_modules`、构建输出、本地 Cache、Browser Profile、Cookie、Token 或本地授权数据。

迁移前远端只读检查结果：

- `ssh apple` 可连接。
- 目标目录为空。
- Apple Silicon，macOS 26.5.2。
- Google Chrome 已安装。
- Homebrew fnm 已安装，现有最高 Node 为 24.14.0，低于仓库要求；接管前需要安装或选择 Node
  25.7.0 以上版本。

## 验证命令

```bash
git status --short --branch
git rev-parse HEAD
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm test -- --reporter=dot
```

Browser 能力另行运行真实公开页面 Smoke；普通单元测试通过不代表 Chrome、网络、代理或授权 Profile
已经验证。

## 不复制的内容

- Codex 原始 JSONL 会话。它包含系统提示、开发者指令、工具调用和环境元数据。
- `~/Library/Application Support/diaoyan/` 下的 Cache、Profile 和审计数据。
- 任何 SSH Key、API Key、Cookie、Authorization Header、代理凭证或 RSL 私钥。
- `node_modules`、`dist` 和临时 Benchmark 工件。

聊天记录使用机械净化导出，只保留用户和助手可见文本；如果需要司法、审计或逐事件级原始记录，必须
在源机器单独授权后处理，不能把原始 Session 当普通文档复制。

## 仍需产品决定

- 首批付费场景决定 Corpus 类别权重。
- P0 是否包含 PDF，还是只包含文章、Shell、JSON、错误页和网络故障。
- `uncertain` 默认是否返回正文。
- Live Canary 的维护 owner 和复核周期。
- Shadow Browser 的成本预算和采样率。
- 第一批站点 Adapter 的选择与 ROI Gate。

## 安全与能力边界

- 不以验证码处理、付费墙绕过、访问控制规避或身份伪装提高成功率。
- 429 按 origin 调度并尊重 `Retry-After`，不轮换身份规避限速。
- 用户授权 Session 只能复用用户已有权限，不能创造权限。
- 目标架构文档不是已实现证明；完成状态只能由代码、测试和 Benchmark 更新。

## Git 交接

本文件所在提交就是本轮设计交接基线。接管时运行 `git rev-parse HEAD` 获取准确 SHA，并核对工作区
干净。迁移使用 Git Bundle/Clone 保留完整历史，不通过复制松散工作区伪造仓库状态。

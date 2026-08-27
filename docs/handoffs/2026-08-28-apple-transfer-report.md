# Diaoyan Apple 迁移验证报告

日期：2026-08-28

## 结果

Diaoyan 已使用完整 Git Bundle 从源仓库复制到：

```text
ssh apple:/Users/apple/Desktop/code/AI/tool/sc
```

目标目录是仓库根目录，没有额外嵌套 `diaoyan/`。迁移时的源提交为
`9126deaf6e3e905bff499b37ed36186d2e89921a`，Bundle 在本地和远端的 SHA-256 均为：

```text
118cc7aa747ef11ba131109fed2511b70f9b96e27e1d2e8f2a02022670effe29
```

迁移报告本身会在上述基线之后以快进提交同步。最终接管 SHA 应以目标机器上
`git rev-parse HEAD` 的输出为准。

## 目标机器环境

| 项目 | 已验证值 |
|---|---|
| 架构 | Apple Silicon `arm64` |
| macOS | 26.5.2 |
| Git | 2.50.1 |
| Node.js | 25.9.0，通过 `/opt/homebrew/bin/fnm` 安装 |
| pnpm | 10.33.2，安装在 Node 25.9.0 环境 |
| Google Chrome | 已安装 |
| Git remote | `https://github.com/majiayu000/fetchtrail.git` |

远端非交互 Shell 默认不暴露 fnm 的 Node 路径。在完成 Shell 初始化前，可使用：

```bash
/opt/homebrew/bin/fnm exec --using=25.9.0 node --version
/opt/homebrew/bin/fnm exec --using=25.9.0 pnpm --version
```

## 远端验证

在目标机器的仓库根目录实际执行：

```bash
/opt/homebrew/bin/fnm exec --using=25.9.0 pnpm install --frozen-lockfile
/opt/homebrew/bin/fnm exec --using=25.9.0 pnpm check
/opt/homebrew/bin/fnm exec --using=25.9.0 pnpm test -- --reporter=dot
```

结果：

- Lockfile 无需更新，依赖安装成功。
- TypeScript `tsc --noEmit` 通过。
- 22 个测试文件通过。
- 200 个测试通过，0 失败。
- 净化后的产品讨论记录和 Apple 接管说明都已在目标机器确认存在。

## 复制范围

已复制：

- 完整 Git 历史、分支和本轮已提交文档。
- Reliability Benchmark、目标架构、实验记录、产品策略和 Roadmap。
- 只包含用户与助手可见文本的净化聊天记录。

未复制：

- Codex 原始 Session JSONL、系统指令、开发者指令、工具日志和环境注入。
- SSH Key、API Key、Cookie、Browser Profile、Authorization Header 和代理凭证。
- 源机器的 Cache、`node_modules`、构建产物和私有 Benchmark 工件。

目标机器的 `node_modules` 是依据锁文件重新安装，不是从源机器复制。

## 未覆盖的边界

- 没有运行真实公网页面的 Chrome Browser Smoke。
- 没有复制登录 Session，因此 X 等授权表面需要在目标机器上单独建立用户授权。
- 设计文档中的 Reliability Harness、Attempt Ledger、Access Planner 和 Durable Frontier 仍是待实现目标，不是已交付功能。
- 尚未对公开竞品跑同 Corpus 的可重复对照，不应声称已在成功率或成本上领先。

## 接管起点

```bash
ssh apple
cd /Users/apple/Desktop/code/AI/tool/sc
/opt/homebrew/bin/fnm exec --using=25.9.0 pnpm check
/opt/homebrew/bin/fnm exec --using=25.9.0 pnpm test -- --reporter=dot
```

然后从 `docs/roadmap.md` 的 v0.11 Reliability Truth 开始，先交付 Case Schema、
Hermetic Fixtures、Controlled Site 和独立 Truth Evaluator。

# GitHub Actions 集成指南

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                     GitHub Actions                        │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────────────┐    ┌──────────────────────────┐ │
│  │  index-pr-history   │    │     code-review.yml      │ │
│  │  (每周一凌晨 3 点)    │    │  (PR 创建/更新时触发)     │ │
│  │                     │    │                          │ │
│  │  索引已合并的 PR     │    │  1. checkout 代码         │ │
│  │  提取 bugfix 模式    │    │  2. 恢复 RAG 缓存        │ │
│  │  生成向量嵌入       │    │  3. 按需索引代码库        │ │
│  │  缓存到 Actions     │    │  4. 并行运行 5 个 Agent   │ │
│  └─────────┬───────────┘    │  5. 交叉验证            │ │
│            │                │  6. 发布 Review 评论     │ │
│            ▼                │  7. Critical → 阻断合并  │ │
│  ┌─────────────────────┐    └──────────────────────────┘ │
│  │   Actions Cache     │                ▲                │
│  │  (向量存储持久化)    │────────────────┘                │
│  └─────────────────────┘                                 │
└──────────────────────────────────────────────────────────┘
```

## 快速开始

### 方式一：内嵌到你的仓库（推荐）

将 review agent 代码放在你仓库的 `.github/code-review-agent/` 目录下。

**第 1 步：复制文件**

```bash
# 在你的项目仓库中
mkdir -p .github/code-review-agent
cp -r <本项目>/src .github/code-review-agent/
cp <本项目>/package.json .github/code-review-agent/
cp <本项目>/tsconfig.json .github/code-review-agent/

# 复制 workflow 文件
cp <本项目>/.github/workflows/code-review.yml .github/workflows/
cp <本项目>/.github/workflows/index-pr-history.yml .github/workflows/
```

**第 2 步：配置 GitHub Secrets**

在仓库的 Settings → Secrets and variables → Actions 中添加：

| Secret 名称 | 说明 | 必需 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 (sk-ant-...) | ✅ |
| `OPENAI_API_KEY` | OpenAI API 密钥，用于生成嵌入向量 | ✅ |

`GITHUB_TOKEN` 由 Actions 自动提供，无需手动配置。

**第 3 步：自定义 Review 规则**

在你的仓库根目录创建 `REVIEW.md`，定义团队的 review 优先级和规则（参考项目中的模板）。

**第 4 步：首次运行 PR 历史索引**

```
Actions → Index PR History → Run workflow
```

之后每周一会自动运行。

### 方式二：作为 Reusable Action 引用

如果你把 review agent 发布为独立仓库，其他项目可以直接引用：

```yaml
# .github/workflows/code-review.yml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
    paths: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    if: "!github.event.pull_request.draft"
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: your-org/code-review-agent@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          fail_on_critical: "true"
```

## Workflow 详解

### code-review.yml — PR 自动审查

**触发条件：**
- PR 被创建（`opened`）
- PR 有新的推送（`synchronize`）
- PR 从草稿变为 Ready（`ready_for_review`）
- 仅在 JS/TS 文件变更时触发

**自动跳过：**
- 草稿 PR
- Dependabot / Renovate 的自动 PR

**并发控制：**
同一个 PR 同时只运行一个 review。如果在 review 进行中推送了新代码，旧的 review 会被取消。

**缓存策略：**
代码库向量索引通过 `actions/cache` 缓存。Cache key 基于源代码文件的 hash，代码变化时自动失效重建。

**关键步骤的运行时间：**

| 步骤 | 首次运行 | 有缓存 |
|---|---|---|
| 代码库索引 | 30-60 秒 | 跳过 |
| Agent 并行审查（标准 PR） | 30-90 秒 | 30-90 秒 |
| 交叉验证 | 15-30 秒 | 15-30 秒 |
| 总计 | 1-3 分钟 | 45 秒 - 2 分钟 |

### index-pr-history.yml — 历史 PR 索引

每周一凌晨 3 点自动运行，拉取最近合并的 PR，识别 bugfix 类型的 PR，提取 diff 和 review 评论，生成向量嵌入供 review agent 在审查时检索。

## 成本估算

| PR 规模 | Agent 数量 | Token 用量 | 预估费用 |
|---|---|---|---|
| 小 (< 50 行) | 1 (Haiku) | ~5K | ~$0.01 |
| 标准 (50-300 行) | 3-4 (Sonnet) | ~50K | ~$0.50 |
| 大 (300-1000 行) | 5 + 验证 (Sonnet) | ~150K | ~$1.50 |
| 超大 (1000+ 行) | 5 + 验证 (Sonnet) | ~250K | ~$2.50 |

嵌入向量费用（OpenAI text-embedding-3-small）极低，每次索引约 $0.01-$0.05。

## 高级配置

### 只对特定目录启用

```yaml
on:
  pull_request:
    paths:
      - "src/**/*.ts"
      - "src/**/*.tsx"
      # 排除测试文件
      - "!**/*.test.ts"
      - "!**/*.spec.ts"
```

### 根据 Label 控制行为

```yaml
jobs:
  review:
    # 跳过打了 "skip-review" 标签的 PR
    if: "!contains(github.event.pull_request.labels.*.name, 'skip-review')"
```

### 仅审查不阻断合并

在 `code-review.yml` 中，删除最后的 "Check for critical findings" 步骤即可。Review 评论仍会发布，但不会阻断 PR 合并。

### 搭配 Branch Protection Rules

在仓库 Settings → Branches → Branch protection rules 中：

1. 勾选 "Require status checks to pass before merging"
2. 搜索并添加 "AI Code Review"
3. 这样只有通过 review（无 critical 发现）的 PR 才能合并

### 与 Slack 联动通知

```yaml
- name: Notify on critical findings
  if: steps.review.outputs.critical_count > 0
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      {
        "text": "⚠️ PR #${{ github.event.pull_request.number }} 发现 ${{ steps.review.outputs.critical_count }} 个严重问题",
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "*<${{ github.event.pull_request.html_url }}|PR #${{ github.event.pull_request.number }}>*: ${{ steps.review.outputs.summary }}"
            }
          }
        ]
      }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## 排错指南

| 问题 | 原因 | 解决方案 |
|---|---|---|
| "Missing required env" | Secret 未配置 | 检查 Settings → Secrets |
| Review 超时 | PR 过大或 API 慢 | 增加 `timeout-minutes` 或拆分大 PR |
| "No reviewable files" | PR 只改了非 JS/TS 文件 | 正常行为，无需处理 |
| 缓存频繁失效 | 代码变动大 | 正常行为，首次索引需 30-60 秒 |
| 嵌入 API 报错 | OpenAI API key 无效 | 验证 key 是否有效且有 embedding 权限 |
| review 发布失败 | GITHUB_TOKEN 权限不足 | 确保 workflow 有 `pull-requests: write` |

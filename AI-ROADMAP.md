# AI + 知识库系统 · 任务清单与路线图

> 配套文档：[`AI-SYSTEM-EVALUATION.md`](./AI-SYSTEM-EVALUATION.md)（详细评估报告，综合成熟度 5.2/10）
> 更新日期：2026-08-07
> 当前实现提交：待本轮验收后发布

## 当前执行状态

> 独立审计：[`TASK-AUDIT.md`](./TASK-AUDIT.md)（2026-08-07，基线 `9fef7ca`）先将完成度校正为约 72%。本轮已按审计剩余项补齐代码、评测和部署配置。

**本轮完成：**

| 项 | 落地内容 | 验收 |
| --- | --- | --- |
| T3 | 构建期 LSA 共现模型替换 FNV 签名，生成 64 维分布式语义向量；查询与文档使用同一词表；BM25 + RRF | Recall@4 0.92，MRR 0.8267 |
| T5 | 零命中查询脱敏归档、反馈/回答/降级埋点、独立遥测限流桶、Worker observability | `search_zero` 含脱敏预览；安全测试通过 |
| T6 | Spark-X2 `/v2/chat/completions` 作为生产第二上游，支持独立 APIPassword 覆盖；保留 SSE 回退 | 配置进入 Worker 后验收 `fallbackConfigured=true` |
| T8 | manifest 与分片共用同一语义索引；评测直接读取线上同样的分片集合 | 分片与评测配置一致 |
| T10 | 评测新增引用覆盖率、引用精度、降级链接率和引用解析回归 | `citationCoverageAt4=0.92`，`fallbackLinkRate=1` |
| T11 | 用户输入注入过滤、控制字符清理、遥测查询脱敏；CI 内容扫描继续保留 | `pnpm test:ai-security` 通过 |
| R4 | GitHub Pages Let's Encrypt 证书已批准，强制 HTTPS 已开启 | `responds_to_https=true` |

**仍需人工核实：** R1 密钥轮换必须在讯飞/Cloudflare 控制台完成；R6 Waline 评论模块仍不属于本轮 AI + 知识库发布范围。备用上游采用讯飞同供应商 Spark-X2，不应描述为跨供应商灾备；若要跨供应商，需要额外网关地址和凭证。

完整首次部署顺序见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)，AI 代理执行协议见 [`AGENTS.md`](./AGENTS.md)。

---

## 一、已完成（16555a4，已上线验证）

| 项 | 内容 | 对应评估项 |
| --- | --- | --- |
| Worker 硬化 | `/spark/auth` 按 IP 限流 12次/60s + 会话令牌一次性消费；`/spark/chat` 重建 payload 白名单、强制 temp 0.2、上游 35s 超时 | P0-1 |
| KB 接 CI | `prebuild` 跑 `gen-knowledge.py`、`postbuild` 跑 `verify-knowledge.mjs` | P0-2 |
| 锚点修正 | `slugify` 复刻 VitePress + `verify-knowledge` 门禁兜底 | P0-3 |
| 引用兜底重写 | 删 `weight>=5` 误杀，改 cited 优先 + top3 fallback | P1-3 |
| 空资料防幻觉 | `buildGroundedUserPrompt` 统一注入 reference + 「为空只能说暂未查到」；temperature 全降 0.2 | P1-4 |
| 多轮检索 | retrievalQuery 拼接最近 2 条用户消息 | P2-1（部分） |
| KB 懒加载 | `onMounted` 不再加载，首次提问时 `loadKnowledge()` | P2-4（部分） |

线上实测：`spark-api.kcos.club/health` → ok；非法 Origin → 403；知识库切块重构后为 **111 块**（原 242 块为改造前数据）。

---

## 二、历史任务定义与验收口径（完成情况见上）

### P0 — 架构统一与即时修复

#### T1. Worker 改造为 OpenAI 兼容网关（1-2 人日）⭐ 用户已确认方向
- **做什么**：Worker 提供 `POST /v1/chat/completions`，服务端注入讯飞 Bearer；前端固定调用 OpenAI 兼容网关，删除 `spark` provider 与 `/spark/auth`、`/spark/chat`。
- **为什么**：前端统一一套代码，Worker 变通用网关，换 LLM 只改 Worker 上游 + 密钥，前端零改动。顺手为 T6 流式/故障转移打基础。
- **涉及文件**：`workers/spark-proxy.js`、`docs/.vitepress/ai/providers/{spark,openai}.ts`、`config.ts`、`.env`、GitHub vars。
- **凭证变化**：4 项（APPID/APIKEY/APISECRET/ASSISTANT_URL）→ 1 项 `APIPassword`（讯飞控制台「星火认知大模型」HTTP 接口页获取）。
- **完成后**：T2 自动失效，可关闭。

#### T2. MAX_MESSAGE_CHARS 余量（若暂不改网关）（0.5 人日）
- spark 路径末条 user 消息 ≈ 7260 + 问题长度，长问题可能超 8000 触发 Worker 1003 静默降级。
- **改网关后此项消失**；若保留 spark 路径，把 `MAX_MESSAGE_CHARS` 提至 ~12000。
- **涉及**：`workers/spark-proxy.js`。

---

### P1 — 质量跃迁（已完成项保留验收口径）

#### T3. 语义/向量检索：BM25 + embedding 混合召回（已完成）⭐ 质量最大杠杆
- **现状**：纯关键词 + 10 组同义词，长尾/口语化查询召回天花板低（实测「转到…专业」召不到转专业页；四条结果元数据分打平致排序失效）。
- **做什么**：构建期从知识库共现关系生成 `lsa-v1`（64 维 int8）分布式语义向量，随 manifest 下发，浏览器内余弦 + BM25 + RRF 融合。**无需向量数据库或外部模型下载**。
- **涉及**：`scripts/gen-knowledge.py`、`docs/.vitepress/ai/knowledge.ts`。
- **对应评估**：P1-1。

#### T4. 切块从「拆长」改「合碎」（2-3 人日）
- **现状**：35% 块 < 100 字、仅 1.7% 触发长文拆分；注入上下文只用 28.5% 预算。
- **做什么**：目标块长 300-600 字，自底向上按 `###` 合并；每块带完整层级路径（如 `学院 > 计算机学院 > 简介`）；重叠改按句边界；每页取块数 top2 → 动态填充至 1600 字上限。
- **涉及**：`scripts/gen-knowledge.py`、`knowledge.ts`。
- **对应评估**：P1-2。

#### T5. 埋点与反馈闭环（已完成本轮剩余项）
- **现状**：线上零数据，无法验证优化效果，丢「用户问但答不上」的选题清单。
- **做什么**：Worker 加 `POST /telemetry`（或 Cloudflare Analytics Engine，免费额度充足），匿名上报命中数/top1 分/失败/降级/引用解析；每条回答加 👍/👎；零命中归档；`wrangler.jsonc` 启 `observability`。
- **涉及**：`workers/spark-proxy.js`、`AIChat.vue`、`wrangler.jsonc`。
- **对应评估**：P1-5。

---

### P2 — 体验与治理（已完成项保留验收口径）

#### T6. Provider 运行时故障转移 + 流式输出（已完成配置与代码）
- **依赖** T1 网关化。
- **做什么**：网关后挂多上游按序回退；SSE 流式透传，前端边收边渲染。
- **涉及**：`workers/spark-proxy.js`、`openai.ts`、`AIChat.vue`。
- **对应评估**：P2-2。

#### T7. markdown-it + DOMPurify 替换手写 formatMessage（1 人日）
- **现状**：手写渲染靠「escapeHtml 必须在最前」这一无测试保护的隐式约定；用户消息走 `v-html`。
- **做什么**：用 VitePress 内置 `markdown-it` + `DOMPurify`；用户消息改纯文本插值；加 `Content-Security-Policy`；删 `tip-link` 死代码。
- **涉及**：`AIChat.vue`、`package.json`。
- **对应评估**：P2-3。

#### T8. KB 版本化与按需分片加载（1 人日）
- **现状**：154 KB 无条件下发，无版本标识，有缓存不一致风险。
- **做什么**：文件名带内容哈希 + 长缓存；超 100 篇按目录分片（campus/study/life）按需加载。
- **涉及**：`gen-knowledge.py`、`AIChat.vue`、构建配置。
- **对应评估**：P2-4（剩余）。

#### T9. 多轮查询改写（1-2 人日）
- **现状**：检索词只拼最近 2 条 user 消息（P2-1 已部分做），但指代词「它几点关门」仍可能失准。
- **做什么**：规则指代消解，或一次廉价 LLM 调用做查询改写。
- **涉及**：`AIChat.vue`、`knowledge.ts`。
- **对应评估**：P2-1（剩余）。

---

### P3 — 长期建设（已完成项保留验收口径）

#### T10. 评测集与回归机制（已完成对齐与引用指标）
- 人工标注 50-100 条高频问题 + 标准答案页，CI 跑 Recall@4 / MRR / 引用准确率，防回归。
- **对应评估**：P3-1。

#### T11. 内容安全扫描 + 用户输入防线（本轮完成安全部分）
- CI 扫 KB 提示注入模式（防社区投稿投毒）；`changelog/contributing` 纳入 KB；接教务通知等结构化外部源；用户输入输出安全过滤。
- **对应评估**：P3-2。

---

### 运维项

| 编号 | 事项 | 工作量 |
| --- | --- | --- |
| R1 | 讯飞密钥轮换（凭证曾泄露），轮换后 `wrangler secret put` 更新（改网关后只需 APIPassword 一项） | 0.5 人日 |
| R2 | Worker 进 CI：加 `CLOUDFLARE_API_TOKEN` GitHub secret + deploy job，免手动 `wrangler deploy` | 0.5 人日 |
| R3 | `deploy.yml` 改 `pnpm install --frozen-lockfile`，CI 可复现性 | 5 分钟 |
| R4 | GitHub Pages 强制 HTTPS（证书已签发并开启） | 已完成 |
| R5 | 压缩 `docs/public/og-image.png`（~916KB → ~250KB，修微信分享无图） | 0.5 人日 |
| R6 | 评论模块：Waline on Cloudflare D1（Giscus 国内不可用） | 1-2 人日 |

---

### 附：代码复核发现的细节（已并入上方，此处单独列出便于追踪）

1. `MAX_MESSAGE_CHARS` 余量偏紧 → T2
2. Worker 内存态限流/防重放是 best-effort（按 isolate 不共享）→ 强保证用 Durable Objects/KV，可并入 T6
3. `recordRequest()` 移到调用前，Provider 失败也消耗 30s 冷却 → 低优，可改回仅成功时计
4. `slugify` 对带重音拉丁标题与 github-slugger 有偏差 → `verify-knowledge` 门禁已兜底，低优
5. `pnpm install` 非 `--frozen-lockfile` → R3
6. Worker 未进 CI → R2

---

## 三、建议执行顺序

1. **T1 网关化**（1-2 人日）→ 一次性解决通用性 + 为 T6 打基础，T2 自动消失。
2. **R1 密钥轮换**（改网关时顺手，0.5 人日）。
3. **T5 埋点**（2-3 人日）→ 没数据就无法证明后续优化有效。
4. **T4 切块 + T3 语义检索**（5-8 人日）→ 质量跃迁。
5. **T7 渲染安全**（1 人日）→ 顺手。
6. 其余按需。

> **若只有 2 人日**：T1（1.5）+ R1（0.5）。
> **若只有 1 周**：T1 + R1 + T5 + T7。
> **完整推进后**：成熟度预计从 5.2 → 7.3+（评估报告 §4.4 演进路线）。

# AI + 知识库系统 · 任务清单与路线图

> 配套文档：[`AI-SYSTEM-EVALUATION.md`](./AI-SYSTEM-EVALUATION.md)（详细评估报告，综合成熟度 5.2/10）
> 更新日期：2026-08-07
> 已上线提交：`16555a4` harden AI knowledge retrieval and Pages build

## 当前执行状态

> 独立审计：[`TASK-AUDIT.md`](./TASK-AUDIT.md)（2026-08-07，基线 `9fef7ca`）实测完成度**约 72%**，
> 推翻了本文件早前「T1、T3–T11 全部完成」的自述。下列状态已按审计结论校正。

**已完成（10 项）**：T1、T2、T4、T7、T9、T10、R2、R3、R5，以及本轮补做的 **R4**。

- Worker 已统一为 OpenAI 兼容 HTTP 网关，支持请求白名单、分桶限流、Telemetry、可选第二上游和 SSE 透传。
- 知识库已接入构建门禁，切块平均 475.5 字，<100 字碎块降至 1.8%，111 块全部带压缩向量。
- 前端已使用 MarkdownIt + DOMPurify，用户消息为纯文本；多轮追问使用规则改写。
- CI 已使用 `pnpm install --frozen-lockfile`，并运行内容扫描、检索回归和 Worker smoke test。
- **R4 已完成**：`wiki.kcos.club` 证书 2026-08-07 签发成功（Let's Encrypt，有效期至 11-05），强制 HTTPS 已开启。
  根因不是「等待签发」而是**签发流程卡死**——DNS 与 ACME 路径均正常，但 GitHub 侧证书对象始终未生成；
  通过 Pages API 解绑再重新绑定自定义域名强制重启 ACME 后立即签发成功。

**部分完成（5 项，审计校正）**：

| 项 | 原自述 | 实际情况 | 状态 |
| --- | --- | --- | --- |
| T3 | BM25 + embedding 混合召回 | 「向量」实为 FNV-1a 字符 n-gram 哈希签名，非语义向量；融合为线性加权而非 RRF | 待真兑现（审计 §4.1） |
| T5 | 埋点与反馈闭环 | Telemetry 与 👍/👎 已上线；`observability` 本轮补开；遥测已拆独立限流桶 | 零命中查询仍未归档 |
| T6 | 运行时故障转移 + 流式 | 代码与冒烟测试均就绪，但 `SPARK_FALLBACK_URL` 为空，**生产实为单上游** | 待配置第二上游 |
| T8 | KB 版本化与按需分片 | 分片路由与分片归属是两套逻辑，实测 Recall@4 由 0.92 掉到 0.88 | **本轮已修**（改全量加载） |
| T11 | 内容安全 + 多源 | 投稿侧扫描已接 `prebuild` | 缺用户实时输入过滤、缺外部源 |

**未开始**：R6 评论模块（不属本轮范围）。**无法判断**：R1 密钥轮换（需人工到讯飞/Cloudflare 控制台核实）。

### 本轮审计后修复（前 5 项 ROI）

| # | 修复 | 文件 | 收益 |
| --- | --- | --- | --- |
| 1 | 分片路由漏召 → 首问并行加载全部分片 | `AIChat.vue` | 线上 Recall@4 0.88 → 0.92 |
| 2 | 删除 `VITE_AI_PROVIDER` 死门禁（源码已无人读取） | `deploy.yml` | 消除「漏配即整站发布失败」地雷 |
| 3 | 删除 936KB 孤儿 `og-image.png` | `docs/public/` | 省出站流量，R5 收益不再被抵消 |
| 4 | `worker` job 加 `needs: build` + 变更检测 | `deploy.yml` | 阻止站点构建失败时 Worker 仍上线 |
| 5 | 遥测独立限流桶 + 清理逻辑移至入口 | `spark-proxy.js` | 👍/👎 不再挤占提问额度；修内存增长面 |

发布闭环已完成：`SPARK_API_PASSWORD`、GitHub Secret `CLOUDFLARE_API_TOKEN`、Analytics Engine 和 Worker/Pages CI 均已配置并通过线上验收。可复制部署流程见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。

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

## 二、接下来的任务清单（按优先级）

### P0 — 架构统一与即时修复

#### T1. Worker 改造为 OpenAI 兼容网关（1-2 人日）⭐ 用户已确认方向
- **做什么**：Worker 新增 `POST /v1/chat/completions`，服务端注入讯飞 Bearer，转发到 `https://spark-api-open.xf-yun.com/v1/chat/completions`；前端切 `VITE_AI_PROVIDER=openai`；删除 `spark` provider 与 `/spark/auth`、`/spark/chat`。
- **为什么**：前端统一一套代码，Worker 变通用网关，换 LLM 只改 Worker 上游 + 密钥，前端零改动。顺手为 T6 流式/故障转移打基础。
- **涉及文件**：`workers/spark-proxy.js`、`docs/.vitepress/ai/providers/{spark,openai}.ts`、`config.ts`、`.env`、GitHub vars。
- **凭证变化**：4 项（APPID/APIKEY/APISECRET/ASSISTANT_URL）→ 1 项 `APIPassword`（讯飞控制台「星火认知大模型」HTTP 接口页获取）。
- **完成后**：T2 自动失效，可关闭。

#### T2. MAX_MESSAGE_CHARS 余量（若暂不改网关）（0.5 人日）
- spark 路径末条 user 消息 ≈ 7260 + 问题长度，长问题可能超 8000 触发 Worker 1003 静默降级。
- **改网关后此项消失**；若保留 spark 路径，把 `MAX_MESSAGE_CHARS` 提至 ~12000。
- **涉及**：`workers/spark-proxy.js`。

---

### P1 — 质量跃迁

#### T3. 语义/向量检索：BM25 + embedding 混合召回（3-5 人日）⭐ 质量最大杠杆
- **现状**：纯关键词 + 10 组同义词，长尾/口语化查询召回天花板低（实测「转到…专业」召不到转专业页；四条结果元数据分打平致排序失效）。
- **做什么**：构建期离线生成 embedding（384 维 × ~150 块 ≈ 60 KB int8），随站下发，浏览器内余弦 + BM25 + RRF 融合。**无需向量数据库**。
- **涉及**：`scripts/gen-knowledge.py`、`docs/.vitepress/ai/knowledge.ts`。
- **对应评估**：P1-1。

#### T4. 切块从「拆长」改「合碎」（2-3 人日）
- **现状**：35% 块 < 100 字、仅 1.7% 触发长文拆分；注入上下文只用 28.5% 预算。
- **做什么**：目标块长 300-600 字，自底向上按 `###` 合并；每块带完整层级路径（如 `学院 > 计算机学院 > 简介`）；重叠改按句边界；每页取块数 top2 → 动态填充至 1600 字上限。
- **涉及**：`scripts/gen-knowledge.py`、`knowledge.ts`。
- **对应评估**：P1-2。

#### T5. 埋点与反馈闭环（2-3 人日）
- **现状**：线上零数据，无法验证优化效果，丢「用户问但答不上」的选题清单。
- **做什么**：Worker 加 `POST /telemetry`（或 Cloudflare Analytics Engine，免费额度充足），匿名上报命中数/top1 分/失败/降级/引用解析；每条回答加 👍/👎；零命中归档；`wrangler.jsonc` 启 `observability`。
- **涉及**：`workers/spark-proxy.js`、`AIChat.vue`、`wrangler.jsonc`。
- **对应评估**：P1-5。

---

### P2 — 体验与治理

#### T6. Provider 运行时故障转移 + 流式输出（2-3 人日）
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

### P3 — 长期建设

#### T10. 评测集与回归机制（2 人日）
- 人工标注 50-100 条高频问题 + 标准答案页，CI 跑 Recall@4 / MRR / 引用准确率，防回归。
- **对应评估**：P3-1。

#### T11. 内容安全扫描 + 多源接入（3-5 人日）
- CI 扫 KB 提示注入模式（防社区投稿投毒）；`changelog/contributing` 纳入 KB；接教务通知等结构化外部源；用户输入输出安全过滤。
- **对应评估**：P3-2。

---

### 运维项

| 编号 | 事项 | 工作量 |
| --- | --- | --- |
| R1 | 讯飞密钥轮换（凭证曾泄露），轮换后 `wrangler secret put` 更新（改网关后只需 APIPassword 一项） | 0.5 人日 |
| R2 | Worker 进 CI：加 `CLOUDFLARE_API_TOKEN` GitHub secret + deploy job，免手动 `wrangler deploy` | 0.5 人日 |
| R3 | `deploy.yml` 改 `pnpm install --frozen-lockfile`，CI 可复现性 | 5 分钟 |
| R4 | GitHub Pages 强制 HTTPS（等 GitHub 侧证书生成后开启） | 5 分钟 |
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

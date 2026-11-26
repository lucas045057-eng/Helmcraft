# 10 · 个人方法库（Method Library）v1

> 分支：`feat/method-library`。设计来源：2026-11-25 Codex × Claude 讨论、Gemini 裁决，及 11-26 对「适用场景」字段的修订（方案二：点名 + 推荐）。

## 1. 目标

收藏你**亲自用过、愿意再用**的 Skill 与 SOP，在做事时按名字点名使用；没有点名时，系统按「适用场景」**推荐**，由你确认后才生效。方法只跟当次任务走，不进入长期记忆，也不改变权限与审批。

## 2. 方法卡

| 字段 | 说明 | 是否参与执行 |
|---|---|---|
| `name` | 唯一名字，点名时使用 | 写入方法块标题 |
| `kind` | `skill` 或 `sop` | — |
| `scenario` 适用场景 | 能拿来判断的句子；**只用于推荐和搜索** | 否 |
| `avoid` 不适合 | 推荐时的反例，命中即不推荐 | 否 |
| `keywords` | 额外检索词 | 否 |
| `steps` 怎么做 | 自由文本；SOP 可用 `『其他方法名』` 引用别的卡 | 是 |
| `done` 什么算做好 | 验收口径 | 是 |
| `examples` 参照 | 「本人确认」的笔记/链接，或中台任务的满意结果 | 是（最多 2 条、截断） |
| `revision` | 每次修改 +1；任务记录使用时的修订号 | — |

卡片状态：手动收藏即为「本人确认」（`self_confirmed`）。挂上中台任务结果后在面板显示为参照。

## 3. 使用路径

1. **点名**：飞书 `用『名字』正文` 或 `/m 名字 正文`；面板新建任务时在「方法」下拉选择。
2. **推荐**：未点名时，Hub 用确定性打分（字符二元组重叠，名字/适用场景/关键词加权，命中「不适合」清零）挑出最高分卡片；超过阈值即在飞书回一张确认卡「要不要用『X』？【用】【不用】」，10 分钟内有效，**不点不执行**。面板在输入需求后显示同样的推荐。
3. **执行**：创建任务时把卡片快照（id、修订号、渲染后的方法块）写入任务；派发时把方法块放在用户需求之前。续聊、重试沿用本任务快照，新任务不继承。
4. **回看**：任务详情显示「使用方法：名字 · r{修订号}」；可在方法库里把该任务挂为参照。

## 4. 不做（v2）

- 工具版本检查（`archify` 版本漂移提示）与 WSL 缺失工具检测。
- 语义（模型）推荐；v1 只做确定性打分，便于测试与解释。
- 方法卡的历史修订回看。

## 5. 存储

`0010_method_library.sql`：`method_cards`、`method_examples`、`method_suggestions`，`tasks.method_json`。

## 6. 接口

- `GET /api/v1/methods?q=`、`POST /api/v1/methods`、`GET|PUT|DELETE /api/v1/methods/:id`
- `POST /api/v1/methods/:id/examples`（`{ taskId }` 或 `{ title, content }`）、`DELETE /api/v1/methods/:id/examples/:exampleId`
- `POST /api/v1/methods/suggest`（`{ prompt }` → 推荐列表）
- `CreateTaskRequest.methodId`（可选）

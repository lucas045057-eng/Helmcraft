# 项目任务

<!-- helmcraft:definition:start -->
~~~json
{
  "schemaVersion": 1,
  "planRevision": 2,
  "requirementsDigest": "sha256:05c25bb4b6cc05b26bfcc5cbd28494ca9470b68116fdb92e7687e0697eb46680",
  "projectVerifySetId": "project-required",
  "items": [
    {
      "id": "T01",
      "title": "P0 有界结束验证进程并确认输出管道状态",
      "requirementRefs": [
        "PRD:B01",
        "PRD:F05"
      ],
      "acceptanceRefs": [
        "AC-18",
        "AC-19"
      ],
      "dependsOn": [],
      "scope": [
        ".gitattributes",
        "packages/worker/src/runner/kill-tree.ts",
        "packages/worker/test",
        "packages/worker/src/harness",
        "packages/protocol/src/harness",
        "packages/protocol/test"
      ],
      "verifySetId": "verify-process"
    },
    {
      "id": "T02",
      "title": "P0 清理未确认时持久隔离工作区并限制新 writer",
      "requirementRefs": [
        "PRD:B01",
        "PRD:F04",
        "PRD:F10"
      ],
      "acceptanceRefs": [
        "AC-06",
        "AC-19",
        "AC-23",
        "AC-25"
      ],
      "dependsOn": [
        "T01"
      ],
      "scope": [
        "packages/worker/src/runner",
        "packages/worker/src/tunnel",
        "packages/protocol/src/worker",
        "packages/hub/src/plugins/orchestrator",
        "packages/worker/test",
        "packages/hub/test",
        "packages/worker/src/harness",
        "packages/worker/src/app.ts",
        "packages/protocol/src/harness",
        "packages/protocol/test"
      ],
      "verifySetId": "verify-quarantine"
    },
    {
      "id": "T03",
      "title": "P0 逐项归因 CI 失败并用独立平台夹具建立双平台基线",
      "requirementRefs": [
        "PRD:B02",
        "PRD:F05"
      ],
      "acceptanceRefs": [
        "AC-18",
        "AC-19",
        "AC-28"
      ],
      "dependsOn": [
        "T02"
      ],
      "scope": [
        ".github/workflows/ci.yml",
        "packages/worker/test",
        "packages/hub/test",
        "scripts",
        "packages/worker/src/runner",
        "packages/worker/src/adapters",
        "packages/worker/src/tunnel",
        "packages/worker/src/security",
        "packages/hub/src/plugins/worker-gateway-ws",
        "packages/hub/src/plugins/orchestrator",
        "packages/protocol/test",
        "packages/dashboard/test",
        "vitest.config.ts"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T04",
      "title": "P1 定义 workflow.v1 能力、严格协议和旧连接兼容",
      "requirementRefs": [
        "PRD:F01",
        "PRD:F03",
        "PRD:F05"
      ],
      "acceptanceRefs": [
        "AC-03",
        "AC-04",
        "AC-16",
        "AC-20",
        "AC-33"
      ],
      "dependsOn": [
        "T03"
      ],
      "scope": [
        "packages/protocol/src",
        "packages/protocol/fixtures",
        "packages/protocol/test",
        "packages/worker/src/tunnel",
        "packages/hub/src/plugins/worker-gateway-ws",
        "packages/worker/test",
        "packages/hub/test"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T05",
      "title": "P1 增量迁移四张领域表、永久步骤键和保留规则",
      "requirementRefs": [
        "PRD:F02",
        "PRD:F03",
        "PRD:F09",
        "PRD:F10"
      ],
      "acceptanceRefs": [
        "AC-03",
        "AC-08",
        "AC-15",
        "AC-22",
        "AC-26"
      ],
      "dependsOn": [
        "T04"
      ],
      "scope": [
        "packages/hub/migrations",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/plugins/retention",
        "packages/hub/test",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T06",
      "title": "P1 项目状态、CAS、永久 Task 关联及托管入口限制",
      "requirementRefs": [
        "PRD:F03",
        "PRD:F04",
        "PRD:F10"
      ],
      "acceptanceRefs": [
        "AC-03",
        "AC-08",
        "AC-22",
        "AC-23",
        "AC-31",
        "AC-33"
      ],
      "dependsOn": [
        "T05"
      ],
      "scope": [
        "packages/hub/src/services",
        "packages/hub/src/plugins/project-workflow",
        "packages/hub/src/plugins/orchestrator",
        "packages/hub/src/app.ts",
        "packages/hub/test",
        "packages/protocol/src",
        "packages/hub/src/plugins/dashboard-api",
        "packages/hub/src/plugins/channel-feishu",
        "packages/hub/src/plugins/store-sqlite"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T07",
      "title": "P2 固定 inspection 注册、结果关联与仓库身份预检",
      "requirementRefs": [
        "PRD:F01",
        "PRD:F04"
      ],
      "acceptanceRefs": [
        "AC-01",
        "AC-06",
        "AC-20",
        "AC-25"
      ],
      "dependsOn": [
        "T06"
      ],
      "scope": [
        "packages/worker/src/workflow",
        "packages/worker/src/tunnel",
        "packages/hub/src/plugins/worker-gateway-ws",
        "packages/hub/src/plugins/orchestrator",
        "packages/hub/test",
        "packages/worker/test",
        "packages/hub/src/plugins/project-workflow",
        "packages/worker/src/app.ts",
        "packages/worker/src/config",
        "packages/worker/src/security",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T08",
      "title": "P2 跨工作区别名占用及重启后隔离对账",
      "requirementRefs": [
        "PRD:F04",
        "PRD:F10"
      ],
      "acceptanceRefs": [
        "AC-01",
        "AC-06",
        "AC-21",
        "AC-23",
        "AC-25"
      ],
      "dependsOn": [
        "T07"
      ],
      "scope": [
        "packages/worker/src/workflow",
        "packages/worker/src/runner",
        "packages/hub/src/plugins/project-workflow",
        "packages/worker/test",
        "packages/hub/test",
        "packages/worker/src/app.ts",
        "packages/worker/src/tunnel",
        "packages/hub/src/plugins/worker-gateway-ws",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T09",
      "title": "P2 固定 CLI 角色策略、模型和只读能力实测",
      "requirementRefs": [
        "PRD:F01",
        "PRD:F06",
        "PRD:F07"
      ],
      "acceptanceRefs": [
        "AC-04",
        "AC-05",
        "AC-10",
        "AC-20"
      ],
      "dependsOn": [
        "T08"
      ],
      "scope": [
        "packages/worker/src/config",
        "packages/worker/src/adapters",
        "packages/worker/src/workflow",
        "packages/worker/src/runner",
        "packages/worker/test",
        "packages/worker/src/harness"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T10",
      "title": "P2 读取完整 Git 工作树、索引及审查包并绑定摘要",
      "requirementRefs": [
        "PRD:F05"
      ],
      "acceptanceRefs": [
        "AC-05",
        "AC-16",
        "AC-20",
        "AC-28"
      ],
      "dependsOn": [
        "T09"
      ],
      "scope": [
        "packages/worker/src/workflow",
        "packages/protocol/src/workflow",
        "packages/worker/test",
        "packages/protocol/test",
        "packages/worker/src/config",
        "packages/worker/src/security"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T11",
      "title": "P2 收集完整角色最终输出和证据；拒绝截断及过期回执",
      "requirementRefs": [
        "PRD:F05",
        "PRD:F06",
        "PRD:F07"
      ],
      "acceptanceRefs": [
        "AC-05",
        "AC-08",
        "AC-16",
        "AC-20"
      ],
      "dependsOn": [
        "T10"
      ],
      "scope": [
        "packages/worker/src/adapters",
        "packages/worker/src/workflow",
        "packages/worker/src/tunnel",
        "packages/hub/src/plugins/project-workflow",
        "packages/mock-cli/src",
        "packages/worker/test",
        "packages/hub/test",
        "packages/worker/src/runner",
        "packages/hub/src/plugins/orchestrator",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T12",
      "title": "P3 可信导入 TASKS、冻结修订及保留预算继承链",
      "requirementRefs": [
        "PRD:F02",
        "PRD:F09",
        "PRD:F10"
      ],
      "acceptanceRefs": [
        "AC-02",
        "AC-21",
        "AC-26",
        "AC-27",
        "AC-35"
      ],
      "dependsOn": [
        "T11"
      ],
      "scope": [
        "packages/worker/src/workflow",
        "packages/hub/src/plugins/project-workflow",
        "packages/protocol/src/workflow",
        "packages/worker/test",
        "packages/hub/test",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T13",
      "title": "P3 单步串行派发、永久去重、活动时间和角色预算",
      "requirementRefs": [
        "PRD:F03",
        "PRD:F04",
        "PRD:F09"
      ],
      "acceptanceRefs": [
        "AC-03",
        "AC-07",
        "AC-08",
        "AC-10",
        "AC-15",
        "AC-22",
        "AC-31"
      ],
      "dependsOn": [
        "T12"
      ],
      "scope": [
        "packages/hub/src/plugins/project-workflow",
        "packages/hub/src/plugins/orchestrator",
        "packages/worker/src/harness",
        "packages/hub/test",
        "packages/worker/test",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T14",
      "title": "P3 五轮审查、连续调试记录与四类顾问触发",
      "requirementRefs": [
        "PRD:F02",
        "PRD:F06",
        "PRD:F07",
        "PRD:F09"
      ],
      "acceptanceRefs": [
        "AC-02",
        "AC-08",
        "AC-09",
        "AC-11",
        "AC-12",
        "AC-13",
        "AC-14",
        "AC-15",
        "AC-21"
      ],
      "dependsOn": [
        "T13"
      ],
      "scope": [
        "packages/hub/src/plugins/project-workflow",
        "packages/protocol/src/workflow",
        "packages/mock-cli/src",
        "packages/hub/test",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T15",
      "title": "P4 捕获验证前后身份并核验必需检查和敏感策略",
      "requirementRefs": [
        "PRD:F05",
        "PRD:F08"
      ],
      "acceptanceRefs": [
        "AC-10",
        "AC-16",
        "AC-18",
        "AC-20"
      ],
      "dependsOn": [
        "T14"
      ],
      "scope": [
        "packages/worker/src/runner",
        "packages/worker/src/workflow",
        "packages/worker/src/harness",
        "packages/hub/src/plugins/project-workflow",
        "packages/worker/test",
        "packages/hub/test",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T16",
      "title": "P4 精确进度投影、复验失败撤回和审查失效",
      "requirementRefs": [
        "PRD:F05",
        "PRD:F06",
        "PRD:F08"
      ],
      "acceptanceRefs": [
        "AC-09",
        "AC-16",
        "AC-17",
        "AC-18"
      ],
      "dependsOn": [
        "T15"
      ],
      "scope": [
        "packages/worker/src/workflow",
        "packages/hub/src/plugins/project-workflow",
        "packages/worker/test",
        "packages/hub/test",
        "packages/worker/src/runner",
        "packages/worker/src/harness",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T17",
      "title": "P4 核验 commit 内容与钩子副作用并对账中断",
      "requirementRefs": [
        "PRD:F07",
        "PRD:F08",
        "PRD:F10"
      ],
      "acceptanceRefs": [
        "AC-01",
        "AC-17",
        "AC-22",
        "AC-25",
        "AC-29"
      ],
      "dependsOn": [
        "T16"
      ],
      "scope": [
        "packages/worker/src/workflow",
        "packages/hub/src/plugins/project-workflow",
        "packages/worker/test",
        "packages/hub/test",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T18",
      "title": "P4 检查固定远端 ref 与 push 回执并防止重复交付",
      "requirementRefs": [
        "PRD:F08",
        "PRD:F10"
      ],
      "acceptanceRefs": [
        "AC-07",
        "AC-23",
        "AC-29",
        "AC-30",
        "AC-33"
      ],
      "dependsOn": [
        "T17"
      ],
      "scope": [
        "packages/worker/src/workflow",
        "packages/hub/src/plugins/project-workflow",
        "packages/hub/test",
        "packages/worker/test",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T19",
      "title": "P4 最终全集验证与受控只读 project_check",
      "requirementRefs": [
        "PRD:F05",
        "PRD:F08",
        "PRD:F12"
      ],
      "acceptanceRefs": [
        "AC-10",
        "AC-16",
        "AC-18",
        "AC-33",
        "AC-34",
        "AC-36"
      ],
      "dependsOn": [
        "T18"
      ],
      "scope": [
        "packages/protocol/src/harness",
        "packages/worker/src/harness",
        "packages/worker/src/runner",
        "packages/hub/src/plugins/project-workflow",
        "packages/hub/test",
        "packages/worker/test",
        "packages/protocol/test",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T20",
      "title": "P5 项目查询、受控操作、版本和幂等 API",
      "requirementRefs": [
        "PRD:F01",
        "PRD:F10",
        "PRD:F11"
      ],
      "acceptanceRefs": [
        "AC-24",
        "AC-25",
        "AC-26",
        "AC-31",
        "AC-32"
      ],
      "dependsOn": [
        "T19"
      ],
      "scope": [
        "packages/hub/src/plugins/dashboard-api",
        "packages/hub/src/plugins/project-workflow",
        "packages/hub/test",
        "packages/protocol/src",
        "packages/hub/src/plugins/channel-feishu",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T21",
      "title": "P5 项目列表、创建入口、导航及基础状态",
      "requirementRefs": [
        "PRD:F11"
      ],
      "acceptanceRefs": [
        "AC-15",
        "AC-27",
        "AC-32",
        "AC-33"
      ],
      "dependsOn": [
        "T20"
      ],
      "scope": [
        "packages/dashboard/src",
        "packages/dashboard/test",
        "packages/hub/test"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T26",
      "title": "P5 详情阶段、证据、预算及受控操作",
      "requirementRefs": [
        "PRD:F11"
      ],
      "acceptanceRefs": [
        "AC-15",
        "AC-27",
        "AC-32",
        "AC-33"
      ],
      "dependsOn": [
        "T21"
      ],
      "scope": [
        "packages/dashboard/src",
        "packages/dashboard/test",
        "packages/hub/test"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T22",
      "title": "P5 从一致快照导出三份报告并核验人工验收目标",
      "requirementRefs": [
        "PRD:F11",
        "PRD:F12"
      ],
      "acceptanceRefs": [
        "AC-14",
        "AC-32",
        "AC-34",
        "AC-35",
        "AC-36"
      ],
      "dependsOn": [
        "T26"
      ],
      "scope": [
        "packages/hub/src/plugins/project-workflow",
        "packages/hub/src/plugins/dashboard-api",
        "packages/dashboard/src",
        "packages/hub/test",
        "packages/dashboard/test",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T23",
      "title": "P6 对账 Hub/Worker 重启、暂停、取消及迟到事件",
      "requirementRefs": [
        "PRD:F04",
        "PRD:F09",
        "PRD:F10"
      ],
      "acceptanceRefs": [
        "AC-06",
        "AC-08",
        "AC-15",
        "AC-21",
        "AC-22",
        "AC-23",
        "AC-24",
        "AC-25",
        "AC-30",
        "AC-31"
      ],
      "dependsOn": [
        "T22"
      ],
      "scope": [
        "packages/hub/src/plugins/project-workflow",
        "packages/worker/src/workflow",
        "packages/hub/test",
        "packages/worker/test",
        "packages/worker/src/runner",
        "packages/worker/src/tunnel",
        "packages/hub/src/plugins/orchestrator",
        "packages/hub/src/plugins/worker-gateway-ws",
        "packages/hub/src/plugins/store-sqlite",
        "packages/hub/src/services"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T24",
      "title": "P6 两项依赖闭环、故障注入、旧任务兼容与独立双平台 CI",
      "requirementRefs": [
        "PRD:B02",
        "PRD:F02",
        "PRD:F03",
        "PRD:F05",
        "PRD:F06",
        "PRD:F07",
        "PRD:F08",
        "PRD:F10",
        "PRD:F12"
      ],
      "acceptanceRefs": [
        "AC-02",
        "AC-07",
        "AC-08",
        "AC-09",
        "AC-10",
        "AC-11",
        "AC-12",
        "AC-13",
        "AC-14",
        "AC-15",
        "AC-17",
        "AC-18",
        "AC-19",
        "AC-21",
        "AC-22",
        "AC-23",
        "AC-24",
        "AC-25",
        "AC-26",
        "AC-27",
        "AC-28",
        "AC-32",
        "AC-33",
        "AC-34",
        "AC-35",
        "AC-36"
      ],
      "dependsOn": [
        "T23"
      ],
      "scope": [
        "packages/hub/test",
        "packages/worker/test",
        "packages/mock-cli/src",
        "packages/dashboard/test",
        ".github/workflows/ci.yml"
      ],
      "verifySetId": "project-required"
    },
    {
      "id": "T25",
      "title": "P6 实际三 CLI 冒烟、运维说明和按最终版本归集验收证据",
      "requirementRefs": [
        "PRD:F01",
        "PRD:F11",
        "PRD:F12"
      ],
      "acceptanceRefs": [
        "AC-01",
        "AC-04",
        "AC-05",
        "AC-07",
        "AC-14",
        "AC-28",
        "AC-34",
        "AC-35",
        "AC-36"
      ],
      "dependsOn": [
        "T24"
      ],
      "scope": [
        "scripts",
        "docs",
        "README.md",
        "AGENTS.md"
      ],
      "verifySetId": "project-required"
    }
  ]
}
~~~
<!-- helmcraft:definition:end -->

<!-- helmcraft:progress:start -->
- [x] T01 P0 有界结束验证进程并确认输出管道状态
- [x] T02 P0 清理未确认时持久隔离工作区并限制新 writer
- [ ] T03 P0 逐项归因 CI 失败并用独立平台夹具建立双平台基线
- [ ] T04 P1 定义 workflow.v1 能力、严格协议和旧连接兼容
- [ ] T05 P1 增量迁移四张领域表、永久步骤键和保留规则
- [ ] T06 P1 项目状态、CAS、永久 Task 关联及托管入口限制
- [ ] T07 P2 固定 inspection 注册、结果关联与仓库身份预检
- [ ] T08 P2 跨工作区别名占用及重启后隔离对账
- [ ] T09 P2 固定 CLI 角色策略、模型和只读能力实测
- [ ] T10 P2 读取完整 Git 工作树、索引及审查包并绑定摘要
- [ ] T11 P2 收集完整角色最终输出和证据；拒绝截断及过期回执
- [ ] T12 P3 可信导入 TASKS、冻结修订及保留预算继承链
- [ ] T13 P3 单步串行派发、永久去重、活动时间和角色预算
- [ ] T14 P3 五轮审查、连续调试记录与四类顾问触发
- [ ] T15 P4 捕获验证前后身份并核验必需检查和敏感策略
- [ ] T16 P4 精确进度投影、复验失败撤回和审查失效
- [ ] T17 P4 核验 commit 内容与钩子副作用并对账中断
- [ ] T18 P4 检查固定远端 ref 与 push 回执并防止重复交付
- [ ] T19 P4 最终全集验证与受控只读 project_check
- [ ] T20 P5 项目查询、受控操作、版本和幂等 API
- [ ] T21 P5 项目列表、创建入口、导航及基础状态
- [ ] T26 P5 详情阶段、证据、预算及受控操作
- [ ] T22 P5 从一致快照导出三份报告并核验人工验收目标
- [ ] T23 P6 对账 Hub/Worker 重启、暂停、取消及迟到事件
- [ ] T24 P6 两项依赖闭环、故障注入、旧任务兼容与独立双平台 CI
- [ ] T25 P6 实际三 CLI 冒烟、运维说明和按最终版本归集验收证据
<!-- helmcraft:progress:end -->

<!-- helmcraft:decisions:start -->
- 全项目 · 需求摘要输入字节：依 §6，采用 definitionRevision=1 和 PRD、TechStack 两个原文件 SHA-256 小写十六进制，每行含 LF，再取 SHA-256。评估基线 c7cd204519fc4853bc7520ac7f13b4b6fd649f7f，输入提交 25e7a971481641cad72d573e567601d652c5deca。已核对两份文档 index/worktree 同为 LF；T01 固定三份输入的 LF 属性，跨平台复用原始摘要。
- 全项目 · 开发角色执行位置：据 Owner 澄清及技术方案 §15，由 T3 承载。唯一写入者 Main，Reviewer Claude Opus 5.5 medium，Advisor agy Gemini Carbon high。产品 Worker 对 agy 的真实模型与权限在 T09/T11 初测、T25 联调取证。
- T01/T02/T03 · 需区分 B01 验证和 B02 全仓基线。依据 §8.5、§14.3 及评估 CI，T01/T02 以预先固定的验证子集覆盖构建、lint、depcheck 与该项进程/隔离测试；T03 起运行项目回归全集，最后重跑合集。Vitest 使用最多两个 worker；浏览器套件在 packages/hub/test，已纳入全量 Vitest。所有命令以仓库根目录运行，任何必需失败都保留。
- T21/T26 · Advisor 提示界面可能超过单轮完整审查输入上限；按 §5.3、§6.3 拆为导航与详情两项，T26 与修订 1 的 T21 共用预算根 T21，保留原 ID 和后续 ID。引用的需求与 AC 不变。
- 全项目 · 查阅源码装配、测试入口和 Advisor 修订 1 意见；扩充各项实现所需路径以覆盖数据事务、运行器、飞书及浏览器测试。范围内仅修改本项需求所需代码。宿主审查、验证、预算和报告快照独立于候选；最终三份报告按 §9.3 从同一快照导出。
- T01 · 两次 REJECT 后，根据 §10.2–10.3 和 Advisor 步骤 phase8-t01-reject2-agy-01，采用真实 Windows Job 检查父进程先退出后的子进程与管道寿命。Windows 测试夹具使用本机 Python 3 标准库，测试端确认 Job 已附加才允许启动后代。故障用例只注入终止操作报错，保留真实 Job 和关闭句柄时的清理。这两项证据覆盖受控收尾与清理不确定的返回；已启用 Job 的隔离逃逸没有直接实测，持久隔离和双平台 CI 分别在 T02、T03 取证。
- T02 · 按 B01、F04、F10 和 §10.2，Worker 在本地 journal 旁持久记录验证占用，确认清理后才释放。旧协议用 WORKSPACE_BUSY 回执与精确诊断拒绝写手。若旧 journal 显示验证中断却没有原物理绑定，当前配置无法证明原路径，Worker 在对账前保守拒绝写入。项目级占用协议及对账按后续工作项实施。
<!-- helmcraft:decisions:end -->

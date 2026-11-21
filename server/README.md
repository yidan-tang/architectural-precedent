# 单人试用部署与运行

## 朋友如何使用

在电脑浏览器打开服务地址，用固定用户名 trial 和负责人单独提供的口令进入。粘贴可发给 Claude 的任务书，点击「生成 Deck」，保持页面打开。完成后可直接翻页、查看出处、单独打开或下载。下载文件包含报告文字与交互，远程图片和网页字体仍需联网。

## Render Web Service

首轮试用可以直接[在 Render 部署试用分支](https://render.com/deploy?repo=https://github.com/yidan-tang/architectural-precedent/tree/trial/copilot-mvp)。登录自己的 Render 工作区，在部署预览中确认只有一个 Free Web Service，将新 Key 填入 `ANTHROPIC_API_KEY` 后确认部署。Render 会生成 `TRIAL_PASSWORD`；部署完成后，在服务的 Environment 页面查看该值，单独发给试用者。试用用户名为 `trial`。

此配置使用临时磁盘，生成后请下载 HTML。Claude 联网生成按 Anthropic 账号用量计费。试用期间手动发布新版本，避免朋友演示时自动重启服务。

如需手动创建 Web Service，选择仓库和试用分支，并填写以下设置。

| 设置 | 值 |
|---|---|
| Root Directory | server |
| Build Command | npm ci --omit=dev |
| Start Command | npm start |
| Health Check Path | /healthz |
| 实例数量 | 1 |
| NODE_VERSION | 22 |
| NODE_ENV | production |
| ANTHROPIC_API_KEY | 在平台环境变量中保存新 Key |
| TRIAL_PASSWORD | 至少 16 字符的随机口令 |
| ANTHROPIC_MODEL | 可选，默认 claude-sonnet-4-6 |
| PORT | 使用平台注入的端口 |
| DECK_DIR | 可选，有持久磁盘时设为 /var/data/decks，磁盘挂载至 /var/data |

用平台的 HTTPS 地址试用。生产模式会在缺少 Key、口令过短或输出路径不可写时阻止启动。默认写入 server/generated。临时磁盘在重启或重新部署后会丢失生成文件；短期试用请当场下载 HTML，需要跨重启保存链接时选择支持持久磁盘的付费实例。首次带 Key 生成前在 Claude Console 确认账单、模型和 web search 权限。本项目不会自动开通付费服务。

[Render 部署说明](https://render.com/docs/deploy-node-express-app) · [持久磁盘说明](https://render.com/docs/disks) · [Claude 联网搜索](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

## 运行机制

服务端调用 Claude Messages API 和 web_search_20250305。对于 pause_turn 回传完整响应续接。模型请求 web_fetch 时，服务器只读取支持的建筑媒体域名，每次跳转都重新校验，设置读取时限与大小上限。保留每个页面实际给出的图片地址。原文不可读时可以引用检索结果，页面会标明「仅检索摘要」；未匹配到该来源的图片显示占位。

每份任务书最多 16,000 个字符，单实例同时处理一个任务，整体限时 8 分钟。断开生成请求会中止本地后续操作，已经发出的供应商请求可能产生费用。每份报告必须有四个不同的来源、完整比较、每例三个分析视角以及按次序排列的五项策略。结构有误时仅要求模型补正一次。直接接口响应仍含统计字段，其中费用仅为默认模型的历史 token 估算，账单以平台为准。

| 接口 | 用途 |
|---|---|
| GET /healthz | 进程健康检查 |
| GET / | 任务书表单 |
| POST /api/generate | JSON 对象含 brief 字符串，成功返回 deckUrl |
| GET /deck/:id | 读取本次生成的 HTML，受试用口令保护 |
| GET /template-preview | 查看原有松阳模板示例 |

报告访问依赖同一试用口令，适用于小范围、可互相共享资料的试用。切勿将 .env、含密钥的旧打包文件或 generated 目录放到 GitHub；密钥曾被分享时到供应商控制台撤销旧值并换新。

## 上线验收

1. 在未登录的新窗口打开服务，确认要求试用口令。用 trial 进入后查看松阳示例。
2. 用一份可外发的新任务书生成，检查报告标题与任务书一致，四个案例来源可打开，比较和五项策略与本项目有关。
3. 检查外观、室内、平面切换、缺图说明、最后一页和下载。在新窗口重开报告链接，验证访问控制。
4. 在供应商控制台记录实际耗时与费用。案例关联性、图片类型和文字事实由建筑师按原文抽查。

提交改动前在 server 目录运行 npm ci 和 npm test。测试涉及真实 Express、SDK 调用协议、固定模型及网页响应、表单和 iframe。CI 使用相同命令。实际供应商的账号权限、额度和研究质量须用部署环境的 Key 验收。

可选的 Chromium 验收脚本为 test/browser_smoke.py。先在独立 Python 环境安装 playwright 并运行 python -m playwright install chromium，再在 server 目录运行 python test/browser_smoke.py。它会启动独立的本地服务、使用测试替身，检查真实浏览器中的翻页、打开原文入口、新窗口和 HTML 下载。

## 审查与后续任务

| 级别 | 状态 | 内容 |
|---|---|---|
| P0 | 已处理 | 生产准入、密钥隔离、错误脱敏、来源与跳转限制、输出转义、结构校验、空目录部署、搜索暂停续接 |
| P0 | 部署方验收 | 使用新 Key 完成一次真实联网生成并检查账单，在分享服务地址前确认成功 |
| P1 | 已处理一部分 | 来源回链、真实图片地址和缺图提示已接入。仍需记录媒体访问限制、图文错配及案例质量 |
| P1 | 试用限制 | 生成中刷新会中止任务，结束后可通过已保存的报告链接重入。临时磁盘的报告应下载 |
| P2 | 待反馈 | 手机演示排版、逐阶段真实进度、首轮建筑师反馈 |

维护步骤为复现任务、保留去标识化输入、分支修复、运行测试、PR 记录验收。账单或上游异常时检查 Render 服务日志中的状态码与 Claude Console。换 Key 或试用口令后重启服务；健康检查只证明进程可用。回滚可选择上一个已验证的部署版本。

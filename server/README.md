# 单人试用部署与运行

## 朋友如何使用

在电脑浏览器打开服务地址即可开始，无需账号或密码。选择「上传任务书」导入 DOCX、文字版 PDF、TXT 或 MD（单个文件最多 10 MB），也可直接粘贴。选文件后，浏览器在本机提取正文。请核对文字和面积表，超过 16,000 字时可在输入框内删减。扫描版 PDF 请先做 OCR。点击「生成 Deck」后，服务器会将编辑后的正文发送给所选 AI 平台。生成期间保持页面打开。完成后可直接翻页、查看出处、单独打开或下载。下载文件包含报告文字与交互，远程图片和网页字体仍需联网。

## Render Web Service

首轮试用可以直接[在 Render 部署试用分支](https://render.com/deploy?repo=https://github.com/yidan-tang/architectural-precedent/tree/trial/copilot-mvp)。登录自己的 Render 工作区，在部署预览中确认只有一个 Free Web Service，将 OpenAI 平台 Key 填入 `OPENAI_API_KEY` 后确认部署。当服务显示 Live 后，将页面顶部的 onrender.com 地址发给朋友。已部署的服务选择 Manual Deploy → Deploy latest commit 即可更新。

此配置使用临时磁盘，生成后请下载 HTML。OpenAI 的模型和联网搜索用量计入部署者的 API 账单。试用期间手动发布新版本，避免朋友演示时自动重启服务。

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
| OPENAI_API_KEY | OpenAI 模式使用，在平台环境变量中保存 |
| OPENAI_MODEL | 可选，默认 gpt-5.4-mini，需支持 Responses API、联网搜索和函数调用 |
| ANTHROPIC_API_KEY | 仅 Claude 模式需要 |
| AI_PROVIDER | 可选，openai 或 anthropic。默认优先已有 OpenAI Key，仅有 Anthropic Key 时使用 Claude |
| ANTHROPIC_MODEL | 可选，默认 claude-sonnet-4-6 |
| PORT | 使用平台注入的端口 |
| DECK_DIR | 可选，有持久磁盘时设为 /var/data/decks，磁盘挂载至 /var/data |

用平台的 HTTPS 地址试用。生产模式会在缺少 Key 或输出路径不可写时阻止启动。默认写入 server/generated。临时磁盘在重启或重新部署后会丢失生成文件；短期试用请当场下载 HTML，需要跨重启保存链接时选择支持持久磁盘的付费实例。首次生成前在所选 API 平台确认额度、模型和联网搜索权限。已创建服务若要改用 OpenAI，可在该服务 Environment 手动添加 OPENAI_API_KEY，若原来指定了 AI_PROVIDER 则改为 openai，并手动部署最新试用提交。本项目不会自动开通付费服务。

[Render 部署说明](https://render.com/docs/deploy-node-express-app) · [持久磁盘说明](https://render.com/docs/disks) · [OpenAI 联网搜索](https://developers.openai.com/api/docs/guides/tools-web-search) · [Claude 联网搜索](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

## 运行机制

OpenAI 模式通过 Responses API 先在指定建筑媒体联网检索，再调用本地 web_fetch 读取案例文章和图片，使用同一套报告校验与 HTML 模板。请求使用 store=false，单次任务内回传工具调用上下文。Claude 模式使用 Messages API 和 web_search_20250305。Claude 对于 pause_turn 回传完整响应续接。模型请求 web_fetch 时，服务器只读取支持的建筑媒体域名，每次跳转都重新校验，设置读取时限与大小上限。保留每个页面实际给出的图片地址。原文不可读时可以引用检索结果，页面会标明「仅检索摘要」；未匹配到该来源的图片显示占位。

每份任务书最多 16,000 个字符，单实例同时处理一个任务，整体限时 8 分钟。断开生成请求会中止本地后续操作，已经发出的供应商请求可能产生费用。每份报告必须有四个不同的来源、完整比较、每例三个分析视角以及按次序排列的五项策略。结构有误时仅要求模型补正一次。直接接口响应仍含统计字段，其中费用仅对默认 Claude 模型提供历史 token 估算，OpenAI 返回空值，账单以平台为准。

| 接口 | 用途 |
|---|---|
| GET /healthz | 进程健康检查 |
| GET / | 任务书表单 |
| POST /api/generate | JSON 对象含 brief 字符串，成功返回 deckUrl |
| GET /deck/:id | 通过独立链接读取新生成的 HTML |
| GET /template-preview | 查看原有松阳模板示例 |

拿到新报告链接的人都可以查看或下载该报告。报告列表仅存在提交者的浏览器中。升级前已保存在磁盘上的报告仍需原有试用口令，生产环境中缺少旧口令时无法访问这些历史报告。切勿将 .env、含密钥的旧打包文件或 generated 目录放到 GitHub；密钥曾被分享时到供应商控制台撤销旧值并换新。

## 上线验收

1. 用无痕窗口打开服务，确认直接显示任务书输入框，点击查看松阳示例。
2. 上传一份可外发的新任务书，核对提取出的项目名称、面积和功能要求，点击生成。检查报告标题与任务书一致，四个案例来源可打开，比较和五项策略与本项目有关。
3. 检查外观、室内、平面切换、缺图说明、最后一页和下载。在另一个无痕窗口打开新报告链接，确认可直接阅读。
4. 在供应商控制台记录实际耗时与费用。案例关联性、图片类型和文字事实由建筑师按原文抽查。

提交改动前在 server 目录运行 npm ci 和 npm test。测试涉及真实 Express、两个供应商的调用协议、固定模型及网页响应、表单和 iframe。CI 使用相同命令。实际供应商的账号权限、额度和研究质量须用部署环境的 Key 验收。

可选的 Chromium 验收脚本为 test/browser_smoke.py。先在独立 Python 环境安装 playwright 并运行 python -m playwright install chromium，再在 server 目录运行 python test/browser_smoke.py。它会启动独立的本地服务、使用测试替身，检查真实浏览器中的四种文件导入、编辑后提交、错误恢复、翻页、打开原文入口、新窗口和 HTML 下载。

## 审查与后续任务

| 级别 | 状态 | 内容 |
|---|---|---|
| P0 | 已处理 | 生产密钥配置、公开试用、历史报告保护、错误脱敏、来源与跳转限制、输出转义、结构校验、空目录部署、搜索暂停续接 |
| P0 | 部署方验收 | 使用新 Key 完成一次真实联网生成并检查账单，在分享服务地址前确认成功 |
| P1 | 已处理一部分 | 来源回链、真实图片地址和缺图提示已接入。仍需记录媒体访问限制、图文错配及案例质量 |
| P1 | 试用限制 | 生成中刷新会中止任务，结束后可通过已保存的报告链接重入。临时磁盘的报告应下载 |
| P2 | 待反馈 | 手机演示排版、逐阶段真实进度、首轮建筑师反馈 |

维护步骤为复现任务、保留去标识化输入、分支修复、运行测试、PR 记录验收。账单或上游异常时检查 Render 服务日志中的状态码与所选 API 平台的用量面板。换 Key 后重启服务；健康检查只证明进程可用。回滚可选择上一个已验证的部署版本。

# Architectural Research Copilot

面向建筑师的前期案例研究工具。粘贴中英文设计任务书，生成一份可翻页、可下载的 HTML 汇报，包含封面、四个案例、横向对比和五项设计策略。案例页可切换外观、室内、平面三个分析视角并打开原文。

[浏览原有松阳示例](https://yidan-tang.github.io/architectural-precedent/) · [部署、验收与维护](server/README.md)

## 本地启动

需要 Node.js 22 或更高版本，以及有 Claude 模型与联网搜索权限的 Anthropic API 项目。

~~~bash
cd server
npm ci
cp .env.example .env
npm test
~~~

在本机编辑 server/.env，把新创建的 API Key 填入 ANTHROPIC_API_KEY，再运行 npm start。打开 http://127.0.0.1:3000 。没有 Key 时仍可在首页点「查看松阳示例」。本地模式只监听回环地址。

## 项目入口

| 文件 | 用途 |
|---|---|
| index.html、01_design_brief.md | 原有静态展示及示例任务书 |
| server/public/index.html | 任务书输入、生成状态、预览与下载 |
| server/server.js | Express、试用准入、Claude 搜索与工具循环、报告保存 |
| server/sources.js | 来源检查、项目页面摘录、真实图片地址提取 |
| server/prompts/system.md | 选例标准、案例分析、五项设计策略、输出结构 |
| server/report.js、server/template.html | 验证报告，渲染原有双语版式和轮播 |
| server/test/ | 使用本地模型与页面夹具的回归测试 |

## 协作分工

产品负责人在 GitHub Issue 写明本轮用户、任务书、预期结果和验收条件。Codex 在分支上实现并测试，将变更和验证结果放入 PR。GitHub 保存源码、Prompt、产品决策、测试与发布版本。真实客户资料、试用口令和 API Key 保存在仓库之外。

首轮验收使用一份可外发的真实任务书。请一位建筑师自行提交、检查四个案例及原文、挑出一个能用于本项目的设计动作，并下载 HTML。记录实际耗时、失效图片以及依据不足的判断，用于下一轮选题。

import express from 'express';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fetchPage, pageUrl } from './sources.js';
import { readReport, renderReport } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;
const MAX_LOOP_STEPS = 16;
const MAX_FETCHES = 24;
const JOB_TIMEOUT_MS = 8 * 60 * 1000;
const production = process.env.NODE_ENV === 'production';
const password = process.env.TRIAL_PASSWORD;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (production && (!apiKey || !password || password.trim().length < 16)) {
  throw new Error('Production requires ANTHROPIC_API_KEY and TRIAL_PASSWORD (at least 16 characters).');
}
const outputDir = path.resolve(__dirname, process.env.DECK_DIR || 'generated');
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
fs.accessSync(outputDir, fs.constants.W_OK);
const digest = (value) => createHash('sha256').update(value).digest();
const credentials = password && digest('trial:' + password);
app.get('/healthz', (_, res) => res.json({ status: 'ok' }));
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  if (!credentials) return next();
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (
    scheme === 'Basic' &&
    encoded &&
    timingSafeEqual(digest(Buffer.from(encoded, 'base64')), credentials)
  )
    return next();
  res
    .set('WWW-Authenticate', 'Basic realm="Architectural Research Trial", charset="UTF-8"')
    .status(401)
    .send('请输入试用用户名和口令。');
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const client = apiKey && new Anthropic({ apiKey, maxRetries: 0, timeout: JOB_TIMEOUT_MS });
let busy = false;
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf-8');
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf-8');

app.post('/api/generate', async (req, res) => {
  const brief = typeof req.body?.brief === 'string' ? req.body.brief.trim() : '';
  if (!brief || brief.length > 16000)
    return res.status(400).json({ error: '请输入 1–16,000 字的设计任务书。' });
  if (!client) return res.status(503).json({ error: '生成服务尚未配置，请联系试用负责人。' });
  if (busy) return res.status(429).json({ error: '已有任务正在生成，请稍后再试。' });
  busy = true;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), JOB_TIMEOUT_MS);
  const disconnect = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', disconnect);
  const startTime = Date.now();
  const evidence = { pages: new Map(), search: new Set() };
  let fetches = 0;
  let repaired = false;
  try {
    const tools = [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 12,
        allowed_domains: ['archdaily.com', 'archdaily.cn', 'gooood.cn', 'dezeen.com'],
      },
      {
        name: 'web_fetch',
        description:
          'Read a project article from ArchDaily, Dezeen or gooood. Returns sourceUrl, article excerpt and actual image URLs with captions when available.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL to fetch (https://...)' },
          },
          required: ['url'],
        },
      },
    ];

    const messages = [{ role: 'user', content: brief }];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const steps = [];

    for (let step = 1; step <= MAX_LOOP_STEPS; step++) {
      const response = await client.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools,
          messages,
        },
        { signal: abort.signal },
      );

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      const textBlocks = response.content.filter((b) => b.type === 'text');
      for (const block of response.content) {
        if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
        for (const result of block.content) {
          const source = pageUrl(result.url);
          if (source) evidence.search.add(source);
        }
      }
      steps.push({ step, stop_reason: response.stop_reason, tools: toolUses.map((t) => t.name) });

      if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
        const finalText = textBlocks.map((b) => b.text).join('');
        let deckData;
        try {
          if (!evidence.search.size)
            throw new Error('Use web_search to obtain supported project sources');
          deckData = readReport(finalText, evidence);
        } catch (error) {
          if (repaired)
            return res
              .status(502)
              .json({
                error: '未取得足够可追溯的案例或完整分析。请检查联网搜索权限，或调整任务书后重试。',
              });
          repaired = true;
          messages.push(
            { role: 'assistant', content: response.content },
            {
              role: 'user',
              content: 'Correct the report and return the entire deck-data JSON. ' + error.message,
            },
          );
          continue;
        }
        const id = 'deck-' + randomUUID();
        const outFile = path.join(outputDir, id + '.html');
        const rendered = renderReport(TEMPLATE, deckData);
        await fs.promises.writeFile(outFile, rendered, { flag: 'wx', mode: 0o600 });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const inK = totalInputTokens / 1000;
        const outK = totalOutputTokens / 1000;
        const cost = (inK * 0.003 + outK * 0.015).toFixed(3);
        return res.json({
          id,
          deckUrl: `/deck/${id}`,
          deckData,
          stats: {
            elapsedSec: Number(elapsed),
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            estCostUSD: MODEL === 'claude-sonnet-4-6' ? Number(cost) : null,
            steps,
          },
        });
      }

      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      if (response.stop_reason === 'tool_use' && toolUses.length) {
        const toolResults = [];
        for (const use of toolUses) {
          let content = 'Unsupported tool or URL.';
          let failed = true;
          if (use.name === 'web_fetch' && pageUrl(use.input?.url)) {
            const url = pageUrl(use.input.url);
            try {
              let page = evidence.pages.get(url);
              if (!page) {
                if (++fetches > MAX_FETCHES) throw new Error('Fetch budget reached');
                page = await fetchPage(url, abort.signal);
                evidence.pages.set(url, page);
                evidence.pages.set(page.url, page);
              }
              content = JSON.stringify({
                sourceUrl: page.url,
                title: page.title,
                excerpt: page.text,
                images: [...page.images].map(([url, caption]) => ({ url, caption })),
              });
              failed = false;
            } catch {
              abort.signal.throwIfAborted();
              content =
                'Project page unavailable. Choose another result or cite the search result and leave image URLs empty.';
            }
          }
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content, is_error: failed });
        }
        messages.push(
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        );
        continue;
      }
      return res.status(502).json({ error: '模型未完成汇报。请缩短任务书或稍后重试。' });
    }
    return res.status(502).json({ error: '已达到本次研究轮次上限。请缩小项目范围后重试。' });
  } catch (error) {
    if (res.destroyed) return;
    const timedOut = abort.signal.aborted || error.name === 'APIConnectionTimeoutError';
    const configError = [401, 403].includes(error.status);
    console.warn('Generation failed', {
      category: timedOut ? 'timeout' : 'upstream-or-storage',
      status: Number(error.status) || null,
    });
    return res
      .status(timedOut ? 504 : 503)
      .json({
        error: timedOut
          ? '生成超时，请稍后重试。'
          : configError
            ? '模型服务鉴权失败，请联系试用负责人检查配置。'
            : '生成服务暂不可用，请联系试用负责人检查模型额度、联网和报告存储。',
      });
  } finally {
    clearTimeout(timeout);
    res.off('close', disconnect);
    busy = false;
  }
});

/* ------------------------------------------------------------------
   Serve generated decks
------------------------------------------------------------------ */
app.get('/deck/:id', (req, res) => {
  const id = req.params.id;
  if (!/^deck-[a-z0-9-]{1,50}$/.test(id)) return res.sendStatus(404);
  const filepath = path.join(outputDir, `${id}.html`);
  if (!fs.existsSync(filepath)) return res.status(404).send('Deck not found');
  res.sendFile(filepath);
});

app.get('/template-preview', (_, res) => {
  // Serve template.html directly (no DECK_DATA → fallback Songyang demo renders)
  res.sendFile(path.join(__dirname, 'template.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  res
    .status(status)
    .json({
      error:
        status === 413
          ? '任务书过长，请精简后重试。'
          : status === 400
            ? '请求格式无效。'
            : '服务暂不可用。',
    });
});

const server = app.listen(PORT, production ? '0.0.0.0' : '127.0.0.1', () => {
  console.log('Architectural Research Copilot listening on port', server.address().port);
});

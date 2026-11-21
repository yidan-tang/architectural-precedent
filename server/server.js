import express from 'express';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fetchPage, pageUrl } from './sources.js';
import { claudeSession, openaiSession } from './model-session.js';
import { readReport, renderReport } from './report.js';
import { urbanStudy, UrbanEvidenceError } from './urban-study.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const openaiKey = process.env.OPENAI_API_KEY?.trim();
const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
const provider = process.env.AI_PROVIDER || (openaiKey ? 'openai' : 'anthropic');
if (!['openai', 'anthropic'].includes(provider))
  throw new Error('AI_PROVIDER must be openai or anthropic.');
const useOpenAI = provider === 'openai';
const MODEL = useOpenAI
  ? process.env.OPENAI_MODEL || 'gpt-5.4-mini'
  : process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;
const MAX_LOOP_STEPS = 16;
const MAX_FETCHES = 24;
const JOB_TIMEOUT_MS = 8 * 60 * 1000;
const production = process.env.NODE_ENV === 'production';
const apiKey = useOpenAI ? openaiKey : anthropicKey;
if (production && !apiKey) throw new Error('Production requires the selected provider API key.');
const outputDir = path.resolve(__dirname, process.env.DECK_DIR || 'generated');
const publicDeckDir = path.join(outputDir, 'public');
fs.mkdirSync(publicDeckDir, { recursive: true, mode: 0o700 });
fs.accessSync(publicDeckDir, fs.constants.W_OK);
const digest = (value) => createHash('sha256').update(value).digest();
const legacyPassword = process.env.TRIAL_PASSWORD;
const legacyCredentials = legacyPassword && digest('trial:' + legacyPassword);
app.get('/healthz', (_, res) => res.json({ status: 'ok' }));
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
});
const reviewOrigin =
  process.env.URBAN_REVIEW_ORIGIN ?? 'https://zhongshan-urban-study.esteemedbeech.chatgpt.site';
app.all(['/api/urban-study', '/api/urban-study/status'], (req, res, next) => {
  res.vary('Origin');
  const origin = req.get('Origin');
  const method = req.path.replace(/\/$/, '').endsWith('/status') ? 'GET' : 'POST';
  if (origin) {
    if (origin === reviewOrigin && /^https?:\/\/[^\s/*]+$/.test(reviewOrigin)) {
      res.set('Access-Control-Allow-Origin', reviewOrigin);
    } else {
      // Render terminates HTTPS upstream, so req.protocol may be HTTP behind its proxy.
      const host = req.get('Host');
      if (origin !== `https://${host}` && origin !== `${req.protocol}://${host}`)
        return res.sendStatus(403);
    }
  }
  if (req.method === 'OPTIONS') {
    if (!origin || req.get('Access-Control-Request-Method') !== method) return res.sendStatus(405);
    const headers = (req.get('Access-Control-Request-Headers') || '')
      .toLowerCase()
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (headers.some((header) => method !== 'POST' || header !== 'content-type'))
      return res.sendStatus(403);
    res.set('Access-Control-Allow-Methods', method);
    if (method === 'POST') res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== method) return res.sendStatus(405);
  next();
});
app.get('/api/urban-study/status', (_, res) => res.json({ available: Boolean(apiKey) }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// The browser reads local documents. Serve only the parser and font assets it needs.
const pdfAssets = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  app.get('/vendor/pdf/' + name, (_, res) => res.sendFile(path.join(pdfAssets, 'legacy/build', name)));
}
for (const dir of ['cmaps', 'standard_fonts']) {
  app.use('/vendor/pdf/' + dir, express.static(path.join(pdfAssets, dir)));
}
app.get('/vendor/fflate.js', (_, res) =>
  res.sendFile(fileURLToPath(import.meta.resolve('fflate/browser'))),
);
const claudeClient =
  !useOpenAI && apiKey && new Anthropic({ apiKey, maxRetries: 0, timeout: JOB_TIMEOUT_MS });
let busy = false;
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf-8');
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf-8');

app.post(['/api/generate', '/api/urban-study'], async (req, res) => {
  const urban = req.path.replace(/\/$/, '') === '/api/urban-study';
  const input = urban ? req.body?.intent : req.body?.brief;
  const brief = typeof input === 'string' ? input.trim() : '';
  if (urban && (!brief || brief.length > 1800))
    return res.status(400).json({ error: '请用 1–1,800 字写下本轮设计意图。' });
  const siteContext = req.body?.siteContext;
  if (
    urban &&
    siteContext !== undefined &&
    (typeof siteContext !== 'string' || siteContext.length > 900)
  )
    return res.status(400).json({ error: '场地说明须为不超过 900 字的文字。' });
  if (!brief || brief.length > 16000)
    return res.status(400).json({ error: '请输入 1–16,000 字的设计任务书。' });
  if (!apiKey) return res.status(503).json({ error: '生成服务尚未配置，请联系试用负责人。' });
  if (busy) return res.status(429).json({ error: '已有任务正在生成，请稍后再试。' });
  busy = true;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), urban ? 150000 : JOB_TIMEOUT_MS);
  const disconnect = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', disconnect);
  const startTime = Date.now();
  const evidence = { pages: new Map(), search: new Set() };
  const attemptedPages = new Set();
  let fetches = 0;
  let repaired = false;
  try {
    if (urban) {
      const study = await urbanStudy({
        intent: brief,
        siteContext: siteContext?.trim(),
        model: MODEL,
        useOpenAI,
        apiKey,
        client: claudeClient,
        signal: abort.signal,
      });
      return res.json(study);
    }
    const options = {
      model: MODEL,
      prompt: SYSTEM_PROMPT,
      brief,
      signal: abort.signal,
      maxTokens: MAX_TOKENS,
    };
    const session = useOpenAI
      ? openaiSession({ ...options, apiKey })
      : claudeSession({ ...options, client: claudeClient });
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const steps = [];

    for (let step = 1; step <= MAX_LOOP_STEPS; step++) {
      const turn = await session.next();
      totalInputTokens += turn.inputTokens;
      totalOutputTokens += turn.outputTokens;
      for (const raw of turn.sources) {
        const source = pageUrl(raw);
        if (source) evidence.search.add(source);
      }
      const toolUses = turn.calls;
      steps.push({ step, stop_reason: turn.stop, tools: toolUses.map((t) => t.name) });
      if (turn.stop === 'end_turn' || turn.stop === 'stop_sequence') {
        let deckData;
        try {
          if (!evidence.search.size)
            throw new Error('Use web_search to obtain supported project sources');
          deckData = readReport(turn.text, evidence);
          if (
            useOpenAI &&
            deckData.cases.some((c) => !c.sourceRead && !attemptedPages.has(c.sourceUrl))
          ) {
            throw new Error(
              'Call web_fetch on every selected project article before composing the report.',
            );
          }
        } catch (error) {
          if (repaired)
            return res.status(502).json({
              error: '未取得足够可追溯的案例或完整分析。请检查联网搜索权限，或调整任务书后重试。',
            });
          repaired = true;
          session.repair('Correct the report and return the entire deck-data JSON. ' + error.message);
          continue;
        }
        const id = 'deck-' + randomUUID();
        const outFile = path.join(publicDeckDir, id + '.html');
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
            estCostUSD: !useOpenAI && MODEL === 'claude-sonnet-4-6' ? Number(cost) : null,
            steps,
          },
        });
      }

      if (turn.stop === 'pause_turn') continue;
      if (turn.stop === 'tool_use' && toolUses.length) {
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
                attemptedPages.add(url);
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
          toolResults.push({ id: use.id, content, failed });
        }
        session.submit(toolResults);
        continue;
      }
      return res.status(502).json({ error: '模型未完成汇报。请缩短任务书或稍后重试。' });
    }
    return res.status(502).json({ error: '已达到本次研究轮次上限。请缩小项目范围后重试。' });
  } catch (error) {
    if (res.destroyed) return;
    if (error instanceof UrbanEvidenceError) {
      return res
        .status(502)
        .json({ error: '本轮未取得三个可追溯的案例与完整构想。可以调整意图后重试。' });
    }
    const timedOut = abort.signal.aborted || error.name === 'APIConnectionTimeoutError';
    const configError = [401, 403].includes(error.status);
    console.warn('Generation failed', {
      category: timedOut ? 'timeout' : 'upstream-or-storage',
      status: Number(error.status) || null,
    });
    return res.status(timedOut ? 504 : 503).json({
      error: timedOut
        ? '生成超时，请稍后重试。'
        : configError
          ? '模型服务鉴权失败，请联系试用负责人检查配置。'
          : error.status === 429
            ? '模型服务额度不足或请求过于频繁，请联系试用负责人检查 API 额度后重试。'
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
  const filename = `${id}.html`;
  const publicFile = path.join(publicDeckDir, filename);
  if (fs.existsSync(publicFile)) return res.sendFile(publicFile);

  // Reports created before the public trial keep their original access restriction.
  const legacyFile = path.join(outputDir, filename);
  if (!fs.existsSync(legacyFile) || (production && !legacyCredentials)) return res.sendStatus(404);
  if (legacyCredentials) {
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    if (
      scheme !== 'Basic' ||
      !encoded ||
      !timingSafeEqual(digest(Buffer.from(encoded, 'base64')), legacyCredentials)
    ) {
      return res
        .set('WWW-Authenticate', 'Basic realm="Architectural Research Trial", charset="UTF-8"')
        .status(401)
        .send('请输入旧版报告的用户名和口令。');
    }
  }
  res.sendFile(legacyFile);
});

app.get('/template-preview', (_, res) => {
  // Serve template.html directly (no DECK_DATA → fallback Songyang demo renders)
  res.sendFile(path.join(__dirname, 'template.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  res.status(status).json({
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

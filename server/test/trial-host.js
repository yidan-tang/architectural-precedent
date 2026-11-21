import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { brief, fixtureReport, urls } from './fixtures.js';

const dir = fileURLToPath(new URL('../', import.meta.url));

export async function startTrial() {
  const steps = [];
  const provider = createServer(async (req, res) => {
    const buf = [];
    for await (const part of req) buf.push(part);
    const request = JSON.parse(Buffer.concat(buf));
    const messages = request.messages;
    const first = messages[0].content;
    steps.push(messages.length);
    if (first === 'slow' && messages.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 250));
    let stop = 'end_turn';
    let content;
    if (messages.length === 1) {
      stop = 'pause_turn';
      content = [
        { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: { query: 'library' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'search-1',
          content: urls.map((url) => ({
            type: 'web_search_result',
            url,
            title: 'Fixture',
            encrypted_content: 'fixture',
          })),
        },
      ];
    } else if (messages.length === 2 && messages[1].content[1]?.type === 'web_search_tool_result') {
      stop = 'tool_use';
      content = urls.map((url, i) => ({
        type: 'tool_use',
        id: 'read-' + i,
        name: 'web_fetch',
        input: { url },
      }));
    } else {
      const report = fixtureReport();
      if (first === 'invalid') report.cases.pop();
      const results = messages.find(
        (m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
      );
      if (results?.content?.length !== 4 || results.content.some((r) => r.is_error)) report.cases = [];
      content = [{ type: 'text', text: '<deck-data>' + JSON.stringify(report) + '</deck-data>' }];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'local-fixture',
        type: 'message',
        role: 'assistant',
        model: request.model,
        content,
        stop_reason: stop,
        usage: { input_tokens: 100, output_tokens: 100 },
      }),
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const dataDir = await mkdtemp(join(tmpdir(), 'architect-reports-'));
  const trialPassword = randomUUID();
  const app = spawn(process.execPath, ['--import', './test/publisher-fixture.js', 'server.js'], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: '0',
      NODE_ENV: 'production',
      TRIAL_PASSWORD: trialPassword,
      DECK_DIR: join(dataDir, 'decks'),
      ANTHROPIC_API_KEY: 'local-test-only',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + provider.address().port,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  async function close() {
    const exited =
      app.exitCode !== null || app.signalCode !== null ? Promise.resolve() : once(app, 'exit');
    app.kill();
    await exited;
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('App did not start')), 6000);
      app.stdout.on('data', (b) => {
        const match = String(b).match(/listening on port (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      app.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('App stopped'));
      });
    });
    return {
      url: 'http://127.0.0.1:' + port,
      auth: 'Basic ' + Buffer.from('trial:' + trialPassword).toString('base64'),
      password: trialPassword,
      brief,
      steps,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

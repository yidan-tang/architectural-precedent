import test from 'node:test';
import assert from 'node:assert/strict';
import { startTrial } from './trial-host.js';

const ids = ['street', 'bridge', 'below'];
const urls = [
  'https://www.london.gov.uk/programmes/urban-study-street',
  'https://www.barbican.org.uk/your-visit/urban-study-highwalks',
  'https://www.rockefellercenter.com/map/urban-study-concourse',
];
const titles = ['地面连接研究', '高架步行研究', '地下商业通廊研究'];

function studyFixture(scenario) {
  const references = [...urls];
  if (scenario === 'unseen-source') references[1] += '-model-invented';
  if (scenario === 'duplicate-source') references[2] = references[0];
  if (scenario === 'foreign-source') references[1] = 'https://unlisted.example.org/study';
  const cases = ids.map((id, i) => ({
    id,
    city: i === 2 ? '纽约' : '伦敦',
    name: titles[i],
    original: 'Example ' + id,
    move: '分段连接各个公共活动节点。',
    evidence: '项目方地图逐段列出了步行节点。',
    limit: '需确认开放时间、通行权和用地边界。',
    source: '项目运营方',
    url: references[i],
  }));
  const schemes = ids.map((id, i) => ({
    id,
    title: titles[i] + '设想',
    idea: '通过可确认的入口串联不同功能节点。',
    tradeoff: '跨业主的开放时间需要协商。',
    check: '向运营方确认两个节点的进出条件。',
    parcels: [1, i + 2],
  }));
  if (scenario === 'invalid-parcel') schemes[0].parcels.push(6);
  return { cases, schemes };
}

function providerFixture(provider, scenario, requests) {
  return async (url, request, res) => {
    const openai = provider === 'openai';
    if (url !== (openai ? '/v1/responses' : '/v1/messages')) return false;
    requests.push(request);
    const urlsFound = [...urls];
    if (scenario === 'foreign-source') urlsFound[1] = 'https://unlisted.example.org/study';
    if (scenario === 'no-evidence') urlsFound.length = 0;
    const text = '<urban-study>' + JSON.stringify(studyFixture(scenario)) + '</urban-study>';
    let response;
    if (openai) {
      response = {
        id: 'resp_study',
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 200 },
        output: [
          {
            type: 'web_search_call',
            id: 'ws_study',
            status: 'completed',
            action: {
              type: 'search',
              query: 'public pedestrian connections',
              sources: urlsFound.slice(0, 2).map((source) => ({ type: 'url', url: source })),
            },
          },
          {
            type: 'message',
            id: 'msg_study',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text,
                annotations: urlsFound.slice(2).map((source) => ({
                  type: 'url_citation',
                  title: 'Concourse',
                  url: source,
                  start_index: 0,
                  end_index: 1,
                })),
              },
            ],
          },
        ],
      };
    } else {
      response = {
        type: 'message',
        id: 'msg_study',
        role: 'assistant',
        model: request.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 200 },
        content: [
          {
            type: 'server_tool_use',
            name: 'web_search',
            id: 'srvtoolu_study',
            input: { query: 'public pedestrian connections' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_study',
            content: urlsFound.map((source) => ({
              type: 'web_search_result',
              title: 'Fixture',
              url: source,
              encrypted_content: 'fixture',
            })),
          },
          { type: 'text', text },
        ],
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return true;
  };
}

function post(h, path, body, headers = {}) {
  return fetch(h.url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

for (const provider of ['openai', 'anthropic']) {
  test(
    provider + ' urban study requires provider search and returns three referenced alternatives',
    async (t) => {
      const requests = [];
      const h = await startTrial(provider, '', providerFixture(provider, 'valid', requests));
      t.after(h.close);
      const intent = '优先检索伦敦与纽约已运营的步行节点，关注夜间通行。';
      const siteContext = '虚构的研究范围含五处测试节点；具体线位与位置尚未确定。';
      const response = await post(h, '/api/urban-study', { intent, siteContext });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.deepEqual(
        result.cases.map((c) => c.url),
        urls,
      );
      assert.deepEqual(
        result.schemes.map((s) => s.id),
        ids,
      );
      const search = requests[0].tools.find((tool) => tool.type.startsWith('web_search'));
      assert.ok(search);
      const domains = provider === 'openai' ? search.filters.allowed_domains : search.allowed_domains;
      for (const source of urls) {
        assert.ok(
          domains.some((domain) => {
            const hostname = new URL(source).hostname;
            return hostname === domain || hostname.endsWith('.' + domain);
          }),
        );
      }
      const messages = requests[0].input || requests[0].messages;
      const userText = JSON.stringify(messages.filter((item) => item.role === 'user'));
      assert.ok(userText.includes(intent));
      assert.ok(userText.includes(siteContext));
      assert.ok(!JSON.stringify(requests[0].instructions || requests[0].system).includes(siteContext));
      if (provider === 'openai') {
        assert.equal(requests[0].store, false);
        assert.equal(requests[0].tool_choice, 'required');
        assert.ok(requests[0].include.includes('web_search_call.action.sources'));
      }
    },
  );
}

test('urban study rejects empty input and refuses results without source or parcel support', async (t) => {
  let scenario = 'valid';
  const requests = [];
  const h = await startTrial('openai', '', (...args) =>
    providerFixture('openai', scenario, requests)(...args),
  );
  t.after(h.close);
  for (const intent of ['', ' '.repeat(8), '长'.repeat(1801), 5]) {
    assert.equal((await post(h, '/api/urban-study', { intent })).status, 400);
  }
  for (const siteContext of ['长'.repeat(901), { parcel: 'fixture' }]) {
    assert.equal((await post(h, '/api/urban-study', { intent: '选择节点。', siteContext })).status, 400);
  }
  assert.equal(requests.length, 0);
  for (scenario of [
    'unseen-source',
    'duplicate-source',
    'foreign-source',
    'no-evidence',
    'invalid-parcel',
  ]) {
    const response = await post(h, '/api/urban-study', { intent: '检查符合指定设计意图的案例。' });
    assert.equal(response.status, 502, scenario + ': ' + (await response.text()));
  }
  scenario = 'valid';
  assert.equal((await post(h, '/api/urban-study', { intent: '重新研究。' })).status, 200);
});

test('urban study hides upstream credentials and diagnostics on provider failure', async (t) => {
  const marker = 'private-provider-fixture-message';
  const h = await startTrial('openai', '', async (_url, _request, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: marker } }));
    return true;
  });
  t.after(h.close);
  const response = await post(h, '/api/urban-study', { intent: '研究通行与运营。' });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-provider-fixture-message|local-openai-fixture/);
});

test('urban study and legacy deck generation share a concurrency limit', async (t) => {
  const requests = [];
  const handler = providerFixture('openai', 'valid', requests);
  const gate = Promise.withResolvers();
  const enteredProvider = Promise.withResolvers();
  const h = await startTrial('openai', '', async (...args) => {
    enteredProvider.resolve();
    await gate.promise;
    return handler(...args);
  });
  t.after(h.close);
  const pending = post(h, '/api/urban-study', { intent: '请重新查证夜间通行。' });
  try {
    await Promise.race([
      enteredProvider.promise,
      pending.then(() => {
        throw new Error('Missing provider call');
      }),
    ]);
    assert.equal((await post(h, '/api/generate', { brief: h.brief })).status, 429);
    assert.equal((await post(h, '/api/urban-study', { intent: '另一请求。' })).status, 429);
  } finally {
    gate.resolve();
  }
  assert.equal((await pending).status, 200);
});

test('a configured review site can check readiness and submit revised intent without credentials', async (t) => {
  const origin = 'https://review.example.org';
  const requests = [];
  const h = await startTrial('openai', '', providerFixture('openai', 'valid', requests), origin);
  t.after(h.close);
  const studyPath = '/api/urban-study';
  const statusPath = studyPath + '/status';
  const headers = { Origin: origin };
  const options = (path, method, from = origin) =>
    fetch(h.url + path, {
      method: 'OPTIONS',
      headers: {
        Origin: from,
        'Access-Control-Request-Method': method,
        ...(method === 'POST' ? { 'Access-Control-Request-Headers': 'content-type' } : {}),
      },
    });
  for (const [path, method] of [
    [studyPath, 'POST'],
    [statusPath, 'GET'],
  ]) {
    const preflight = await options(path, method);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const methods = preflight.headers.get('access-control-allow-methods');
    assert.ok(
      methods
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .includes(method),
    );
    if (method === 'POST') {
      assert.match(preflight.headers.get('access-control-allow-headers'), /content-type/i);
    }
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    const wrongMethod = await options(path, 'DELETE');
    assert.equal(wrongMethod.status, 405);
    assert.doesNotMatch(wrongMethod.headers.get('access-control-allow-methods') || '', /delete/i);
  }
  const status = await fetch(h.url + statusPath, { headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { available: true });
  assert.equal(status.headers.get('access-control-allow-origin'), origin);
  assert.equal(status.headers.get('access-control-allow-credentials'), null);
  const nearOrigin = origin + '.invalid';
  const outsidePreflight = await options(studyPath, 'POST', nearOrigin);
  assert.equal(outsidePreflight.headers.get('access-control-allow-origin'), null);
  const outsidePost = await post(
    h,
    studyPath,
    { intent: '核对公共节点的开放安排。' },
    { Origin: nearOrigin },
  );
  assert.equal(outsidePost.status, 403);
  assert.equal(outsidePost.headers.get('access-control-allow-origin'), null);
  for (const path of ['/api/generate', '/healthz']) {
    assert.equal((await options(path, 'POST')).headers.get('access-control-allow-origin'), null);
  }
  assert.equal(requests.length, 0);
  const siteContext = '示'.repeat(900);
  for (const intent of ['先比较公共节点的白天使用。', '改为优先比较公共节点的夜间开放条件。']) {
    const response = await post(h, studyPath, { intent, siteContext }, headers);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    const userText = JSON.stringify(requests.at(-1).input.filter((item) => item.role === 'user'));
    assert.ok(userText.includes(intent));
    assert.ok(userText.includes(siteContext));
  }
});

test('unconfigured local service reports unavailable without a provider request', async (t) => {
  const h = await startTrial('unconfigured');
  t.after(h.close);
  const defaultOrigin = 'https://zhongshan-urban-study.esteemedbeech.chatgpt.site';
  const status = await fetch(h.url + '/api/urban-study/status', { headers: { Origin: defaultOrigin } });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('access-control-allow-origin'), defaultOrigin);
  assert.deepEqual(await status.json(), { available: false });
  assert.equal((await post(h, '/api/urban-study', { intent: '复核节点。' })).status, 503);
  assert.equal(h.steps.length, 0);
});

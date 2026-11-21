import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import { extractPage, fetchPage, pageUrl } from '../sources.js';
import { readReport, renderReport } from '../report.js';
import { fixtureReport, photo, urls } from './fixtures.js';
import { startTrial } from './trial-host.js';

test('source tools preserve real URLs and check the destination of each redirect', async () => {
  const page = extractPage(
    '<meta content="项目说明" name="description"><img data-src="/photo.jpg" alt="室内"><img src="' +
      photo +
      '?a=1&amp;b=2">',
    urls[0],
  );
  assert.match(page.text, /项目说明/);
  assert.ok(page.images.has(photo + '?a=1&b=2'));
  assert.equal(page.images.get('https://www.archdaily.com/photo.jpg'), '室内');
  assert.equal(pageUrl('https://example.org/article'), '');
  let requests = 0;
  const redirect = async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'https://example.org/article' } });
  };
  await assert.rejects(fetchPage(urls[0], new AbortController().signal, redirect));
  assert.equal(requests, 1);
});

test('reports require attributed cases and complete analysis; absent images remain empty', () => {
  const data = fixtureReport();
  const evidence = { search: new Set(urls), pages: new Map() };
  const parse = () => readReport('<deck-data>' + JSON.stringify(data) + '</deck-data>', evidence);
  assert.equal(parse().cases[0].images[0].url, '');
  data.cases[1].sourceUrl = urls[0];
  assert.throws(parse, /distinct/);
  data.cases[1].sourceUrl = urls[1];
  data.takeaways.pop();
  assert.throws(parse, /5 takeaways/);
  const html = renderReport('<head></head>', { title: 'Art < Study & $&' });
  assert.ok(html.includes('Art \\u003c Study & $&'));
});

test('web form, tool loop, 11-page iframe, original sources, retry and protected result', async (t) => {
  const h = await startTrial();
  t.after(h.close);
  const headers = { authorization: h.auth };
  const get = (path) => fetch(h.url + path, { headers });
  const post = (brief) =>
    fetch(h.url + '/api/generate', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ brief }),
    });
  assert.equal((await fetch(h.url + '/healthz')).status, 200);
  assert.equal((await fetch(h.url + '/')).status, 401);
  assert.equal((await post('')).status, 400);
  assert.equal((await post('x'.repeat(16001))).status, 400);
  assert.equal((await post('invalid')).status, 502);
  h.steps.length = 0;
  const html = await (await get('/')).text();
  class LocalResources extends ResourceLoader {
    fetch(url) {
      if (!url.startsWith(h.url + '/deck/')) return null;
      return globalThis.fetch(url, { headers }).then(async (r) => Buffer.from(await r.arrayBuffer()));
    }
  }
  const errors = [];
  const log = new VirtualConsole().on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: h.url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: new LocalResources(),
    virtualConsole: log,
    beforeParse(window) {
      window.fetch = (url, init) =>
        fetch(new URL(url, h.url), { ...init, headers: { ...headers, ...init.headers } });
    },
  });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  doc.querySelector('#sample-btn').click();
  assert.match(doc.querySelector('#brief').value, /陈家铺/);
  doc.querySelector('#brief').value = h.brief;
  doc.querySelector('#submit-btn').click();
  const frame = doc.querySelector('#preview');
  for (let i = 0; i < 120 && !frame.contentDocument?.querySelector('.source-link'); i++) await delay(30);
  const deck = frame.contentDocument;
  assert.deepEqual(errors, []);
  assert.deepEqual(h.steps, [1, 2, 4]);
  assert.equal(deck.title, '深圳社区图书馆 — 前期案例研究');
  assert.equal(deck.querySelectorAll('section.page').length, 11);
  assert.equal(deck.querySelectorAll('.source-link').length, 4);
  assert.equal(deck.querySelector('.source-link').href, urls[0]);
  assert.equal(deck.querySelector('h1').textContent.trim(), '深圳社区图书馆');
  assert.ok(deck.querySelector('.cover-col strong'));
  const key = (key) => deck.dispatchEvent(new frame.contentWindow.KeyboardEvent('keydown', { key }));
  key('ArrowDown');
  key('ArrowRight');
  assert.equal(deck.querySelector('section.active').dataset.idx, '1');
  assert.equal(deck.querySelector('section.active .c-dot.active').dataset.idx, '1');
  key('End');
  assert.equal(deck.querySelector('section.active .tph-cn').textContent, '运营策略');
  assert.equal(doc.querySelector('#download').href, frame.src);
  assert.match(doc.querySelector('#history-list').textContent, /深圳社区图书馆/);
  assert.equal((await fetch(frame.src)).status, 401);
  assert.equal((await fetch(frame.src, { headers })).status, 200);
});

test('a second simultaneous generation is refused until the current trial finishes', async (t) => {
  const h = await startTrial();
  t.after(h.close);
  const generate = (brief) =>
    fetch(h.url + '/api/generate', {
      method: 'POST',
      headers: { authorization: h.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ brief }),
    });
  const pending = generate('slow');
  for (let i = 0; i < 100 && !h.steps.length; i++) await delay(5);
  assert.equal((await generate(h.brief)).status, 429);
  assert.equal((await pending).status, 200);
  assert.equal((await generate(h.brief)).status, 200);
});

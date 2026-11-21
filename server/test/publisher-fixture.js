// Only loaded by the test subprocess. All article reads use fixed test data.
import { urls, photo } from './fixtures.js';
globalThis.fetch = async (url) => {
  if (!urls.includes(String(url))) throw new Error('Unknown fixture page');
  return new Response('<article>公共建筑案例</article><img alt="Exterior" src="' + photo + '">', {
    headers: { 'content-type': 'text/html' },
  });
};

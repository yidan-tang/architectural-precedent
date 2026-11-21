// Only loaded by the test subprocess. All article reads use fixed test data.
import { urls, photo } from './fixtures.js';
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (url === 'https://api.openai.com/v1/responses') {
    return nativeFetch(process.env.TEST_PROVIDER_URL + '/v1/responses', init);
  }
  if (!urls.includes(String(url))) throw new Error('Unknown fixture page');
  return new Response('<article>公共建筑案例</article><img alt="Exterior" src="' + photo + '">', {
    headers: { 'content-type': 'text/html' },
  });
};

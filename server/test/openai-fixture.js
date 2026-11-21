// Local Responses API fixture. No requests from these tests go to OpenAI.
import { fixtureReport, urls } from './fixtures.js';

export function respondOpenAI(request, authorized, res) {
  const first = request.input[0].content;
  const usage = { input_tokens: 100, output_tokens: 40 };
  res.setHeader('Content-Type', 'application/json');
  if (!authorized || first === 'bad-key') {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: { message: 'private provider diagnostic' } }));
  }
  if (first === 'quota') {
    res.writeHead(429);
    return res.end('{}');
  }
  const valid =
    request.store === false &&
    request.include.includes('web_search_call.action.sources') &&
    request.tools[0].filters.allowed_domains.includes('archdaily.com');
  if (!valid) {
    res.writeHead(400);
    return res.end('{}');
  }
  let output;
  const search = request.input.find((item) => item.type === 'web_search_call');
  if (!search && request.tool_choice === 'required') {
    output = [
      { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'fixture-context' },
      {
        type: 'web_search_call',
        id: 'ws_fixture',
        status: 'completed',
        action: {
          type: 'search',
          query: '深圳社区图书馆',
          sources: first === 'no-sources' ? [] : urls.map((url) => ({ type: 'url', url })),
        },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Research in progress', annotations: [] }],
      },
    ];
  } else if (!request.input.some((item) => item.type === 'function_call')) {
    if (
      !search ||
      !request.input.some((item) => item.encrypted_content === 'fixture-context') ||
      !request.tools.some((tool) => tool.type === 'function' && tool.name === 'web_fetch')
    ) {
      res.writeHead(400);
      return res.end('{}');
    }
    output = urls.map((url, i) => ({
      type: 'function_call',
      name: 'web_fetch',
      id: 'fc_' + i,
      call_id: 'call_' + i,
      arguments: JSON.stringify({ url }),
    }));
  } else {
    const results = request.input.filter((item) => item.type === 'function_call_output');
    const report = fixtureReport();
    if (
      results.length !== 4 ||
      results.some((r, i) => r.call_id !== 'call_' + i || !JSON.parse(r.output).images.length)
    ) {
      res.writeHead(400);
      return res.end('{}');
    }
    const corrected = request.input.at(-1).role === 'user';
    if (first === 'invalid' || (first === 'repair' && !corrected)) report.cases.pop();
    output = [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: '<deck-data>' + JSON.stringify(report) + '</deck-data>',
            annotations: [],
          },
        ],
      },
    ];
  }
  return res.end(
    JSON.stringify({
      id: 'resp_fixture',
      status: first === 'incomplete' ? 'incomplete' : 'completed',
      output,
      usage,
    }),
  );
}

import { PUBLISHERS } from './sources.js';

const pageTool = {
  name: 'web_fetch',
  description:
    'Read a project article from ArchDaily, Dezeen or gooood. Returns the article URL, excerpt, and actual image URLs with captions when available.',
};
const parameters = {
  type: 'object',
  properties: { url: { type: 'string', description: 'Full HTTPS project article URL.' } },
  required: ['url'],
  additionalProperties: false,
};

// Each generation gets its own conversation. The server handles research and rendering for both APIs.
export function claudeSession({ client, model, prompt, brief, signal, maxTokens }) {
  const messages = [{ role: 'user', content: brief }];
  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 12, allowed_domains: PUBLISHERS },
    { ...pageTool, input_schema: parameters },
  ];
  return {
    async next() {
      const r = await client.messages.create(
        { model, system: prompt, messages, tools, max_tokens: maxTokens },
        { signal },
      );
      messages.push({ role: 'assistant', content: r.content });
      return {
        stop: r.stop_reason,
        text: r.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(''),
        sources: r.content
          .filter((b) => b.type === 'web_search_tool_result' && Array.isArray(b.content))
          .flatMap((b) => b.content.map((result) => result.url)),
        calls: r.content.filter((b) => b.type === 'tool_use'),
        inputTokens: r.usage.input_tokens,
        outputTokens: r.usage.output_tokens,
      };
    },
    submit(results) {
      messages.push({
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          is_error: r.failed,
        })),
      });
    },
    repair(message) {
      messages.push({ role: 'user', content: message });
    },
  };
}

export function openaiSession({ apiKey, model, prompt, brief, signal, maxTokens }) {
  const input = [{ role: 'user', content: brief }];
  const tools = [
    { type: 'web_search', filters: { allowed_domains: PUBLISHERS } },
    { type: 'function', ...pageTool, parameters, strict: true },
  ];
  return {
    async next() {
      const searchFirst = input.length === 1;
      const http = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        redirect: 'error',
        signal,
        body: JSON.stringify({
          model,
          store: false,
          instructions: searchFirst
            ? prompt + '\nFor this first search turn, identify candidate project articles and return a short list of titles and exact URLs. The next turn will fetch articles before writing the report.'
            : prompt,
          input,
          tools: searchFirst ? [tools[0]] : tools,
          include: ['web_search_call.action.sources', 'reasoning.encrypted_content'],
          tool_choice: searchFirst ? 'required' : 'auto',
          max_output_tokens: maxTokens,
          max_tool_calls: 12,
        }),
      });
      if (!http.ok) {
        await http.body?.cancel();
        throw Object.assign(new Error('OpenAI request failed'), { status: http.status });
      }
      const r = await http.json();
      const output = r.output || [];
      // With store:false, carry the returned items (including encrypted reasoning) through tool turns.
      input.push(...output);
      const sources = [];
      const calls = [];
      const texts = [];
      for (const item of output) {
        if (item.type === 'web_search_call' && item.status === 'completed') {
          for (const source of item.action?.sources || []) sources.push(source.url);
          if (item.action?.type === 'open_page') sources.push(item.action.url);
        } else if (item.type === 'message') {
          for (const part of item.content) {
            if (part.type !== 'output_text') continue;
            texts.push(part.text);
            for (const citation of part.annotations || []) {
              if (citation.type === 'url_citation') sources.push(citation.url);
            }
          }
        } else if (item.type === 'function_call') {
          let args = {};
          try {
            args = JSON.parse(item.arguments);
          } catch {
            /* Return a tool error for malformed arguments. */
          }
          calls.push({ id: item.call_id, name: item.name, input: args });
        }
      }
      let stop = r.status;
      if (stop === 'completed') stop = calls.length ? 'tool_use' : 'end_turn';
      if (searchFirst && stop === 'end_turn') {
        input.push({
          role: 'user',
          content:
            'Continue researching this brief. Use web_fetch on the project articles to inspect available photos and plans, then produce the complete deck-data JSON.',
        });
        stop = 'pause_turn';
      }
      return {
        stop,
        calls,
        sources,
        text: texts.join(''),
        inputTokens: r.usage?.input_tokens || 0,
        outputTokens: r.usage?.output_tokens || 0,
      };
    },
    submit(results) {
      for (const r of results)
        input.push({ type: 'function_call_output', call_id: r.id, output: r.content });
    },
    repair(message) {
      input.push({ role: 'user', content: message });
    },
  };
}

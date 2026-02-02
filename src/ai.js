import { request } from 'undici';

export async function summarizeWithOpenAI({ apiKey, model, prompt, timeoutMs = 60000 }) {
  if (!apiKey) return null;

  // Uses the Responses API style payload (works for modern OpenAI accounts).
  const body = {
    model,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    ],
  };

  const res = await request('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });

  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`OpenAI HTTP ${res.statusCode}: ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text);

  // Extract first text output if present
  const output = json.output || [];
  for (const item of output) {
    const content = item.content || [];
    for (const c of content) {
      if (c.type === 'output_text' && c.text) return c.text.trim();
    }
  }
  return null;
}

export const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_NVIDIA_MODEL = 'openai/gpt-oss-20b';

const PROVIDER_ERRORS = {
  401: { code: 'authentication_failed', message: 'NVIDIA NIM authentication failed (HTTP 401). Check NVIDIA_API_KEY.' },
  403: { code: 'access_denied', message: 'NVIDIA NIM denied access to this model (HTTP 403). Check model access for this API key.' },
  404: { code: 'model_not_found', message: 'NVIDIA NIM could not find this model or endpoint (HTTP 404). Check NVIDIA_MODEL and NVIDIA_BASE_URL.' },
  410: { code: 'model_retired', message: 'NVIDIA NIM no longer serves this model (HTTP 410). Configure a current NVIDIA_MODEL.' },
  429: { code: 'rate_limited', message: 'NVIDIA NIM rate limit reached (HTTP 429). Try again later.' },
  500: { code: 'provider_error', message: 'NVIDIA NIM encountered an internal error (HTTP 500).' },
};

function providerError(status) {
  return PROVIDER_ERRORS[status] ?? {
    code: status >= 500 ? 'provider_error' : 'request_rejected',
    message: `NVIDIA NIM rejected the request (HTTP ${status}).`,
  };
}

export class NvidiaRequestError extends Error {
  constructor(message, { status = null, code = 'request_failed', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'NvidiaRequestError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function chatEndpoint(baseUrl = DEFAULT_NVIDIA_BASE_URL) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('NVIDIA_BASE_URL must be a valid HTTPS URL.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new TypeError('NVIDIA_BASE_URL must be an HTTPS URL without credentials or query parameters.');
  }
  return `${base.href.replace(/\/+$/, '')}/chat/completions`;
}

export async function nvidiaChatCompletion({
  apiKey,
  model,
  baseUrl = DEFAULT_NVIDIA_BASE_URL,
  messages,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  maxTokens = 1024,
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('NVIDIA_API_KEY is required.');
  if (typeof model !== 'string' || !model.trim() || model.length > 120) throw new TypeError('NVIDIA_MODEL must be a model name.');
  if (!Array.isArray(messages) || messages.length < 2 || messages.length > 8) throw new TypeError('NVIDIA messages are outside the allowed bounds.');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new TypeError('NVIDIA max tokens are outside the allowed bounds.');

  const url = chatEndpoint(baseUrl);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const detail = providerError(response.status);
        const error = new NvidiaRequestError(detail.message, {
          status: response.status,
          code: detail.code,
          retryable,
        });
        if (retryable && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          lastError = error;
          continue;
        }
        throw error;
      }

      let payload;
      try { payload = await response.json(); } catch (cause) {
        throw new NvidiaRequestError('NVIDIA NIM returned an invalid response.', { cause });
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        const finish = payload?.choices?.[0]?.finish_reason;
        const thinking = Boolean(payload?.choices?.[0]?.message?.reasoning_content || payload?.choices?.[0]?.message?.reasoning);
        throw new NvidiaRequestError(
          `NVIDIA NIM returned no assistant content (finish_reason=${finish ?? 'unknown'}${thinking ? ', the model used the whole token budget thinking' : ''}).`,
          { code: 'empty_content' },
        );
      }
      return content;
    } catch (error) {
      const retryable = error?.retryable
        || error?.name === 'TimeoutError'
        || error?.name === 'AbortError'
        || error?.name === 'TypeError';
      if (retryable && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        lastError = error;
        continue;
      }
      if (error instanceof NvidiaRequestError) throw error;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new NvidiaRequestError(
        timedOut ? 'NVIDIA NIM request timed out.' : 'NVIDIA NIM network request failed.',
        { retryable, code: timedOut ? 'timeout' : 'network_error', cause: error },
      );
    }
  }
  if (lastError instanceof NvidiaRequestError) throw lastError;
  throw new NvidiaRequestError('NVIDIA NIM request failed.', { retryable: true, cause: lastError });
}

/**
 * Chat completion that can carry tool definitions. Returns the whole assistant message
 * ({ content, tool_calls }) so the caller can run the tool-call loop. Same auth, timeout and one-retry policy as above.
 */
export async function nvidiaChatMessage({
  apiKey, model, baseUrl = DEFAULT_NVIDIA_BASE_URL, messages, tools,
  fetchImpl = globalThis.fetch, timeoutMs = 30_000, maxTokens = 1500,
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('NVIDIA_API_KEY is required.');
  if (typeof model !== 'string' || !model.trim() || model.length > 120) throw new TypeError('NVIDIA_MODEL must be a model name.');
  if (!Array.isArray(messages) || messages.length < 2 || messages.length > 24) throw new TypeError('NVIDIA messages are outside the allowed bounds.');
  const url = chatEndpoint(baseUrl);
  const body = { model, temperature: 0, max_tokens: maxTokens, messages, stream: false };
  if (tools?.length) { body.tools = tools.map((t) => ({ type: 'function', function: t })); body.tool_choice = 'auto'; }
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const detail = providerError(response.status);
        const error = new NvidiaRequestError(detail.message, { status: response.status, code: detail.code, retryable: response.status === 429 || response.status >= 500 });
        if (error.retryable && attempt === 0) { lastError = error; await new Promise((r) => setTimeout(r, 100)); continue; }
        throw error;
      }
      let payload;
      try { payload = await response.json(); } catch (cause) { throw new NvidiaRequestError('NVIDIA NIM returned an invalid response.', { cause }); }
      const choice = payload?.choices?.[0];
      const message = choice?.message;
      const hasText = typeof message?.content === 'string' && message.content.trim();
      if (!hasText && !message?.tool_calls?.length) {
        throw new NvidiaRequestError(`NVIDIA NIM returned no assistant content (finish_reason=${choice?.finish_reason ?? 'unknown'}).`, { code: 'empty_content' });
      }
      return { content: hasText ? message.content : '', tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [] };
    } catch (error) {
      const retryable = error?.retryable || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
      if (retryable && attempt === 0) { lastError = error; await new Promise((r) => setTimeout(r, 100)); continue; }
      if (error instanceof NvidiaRequestError) throw error;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new NvidiaRequestError(timedOut ? 'NVIDIA NIM request timed out.' : 'NVIDIA NIM network request failed.', { retryable, code: timedOut ? 'timeout' : 'network_error', cause: error });
    }
  }
  throw lastError instanceof NvidiaRequestError ? lastError : new NvidiaRequestError('NVIDIA NIM request failed.', { retryable: true, cause: lastError });
}

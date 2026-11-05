import { h, icon, clear } from './dom.js';
import { api } from './api.js';

const SUGGESTIONS = [
  'How much did I receive in total?',
  'Find suspicious or duplicate payments.',
  'How much is left in my mandate budgets?',
  'Generate a financial report.',
  'Explain the difference between UPI and NEFT.',
];

function inlineMarkdown(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).map((part) => {
    if (part.startsWith('**') && part.endsWith('**')) return h('strong', {}, part.slice(2, -2));
    if (part.startsWith('`') && part.endsWith('`')) return h('code', {}, part.slice(1, -1));
    if (part.startsWith('*') && part.endsWith('*')) return h('em', {}, part.slice(1, -1));
    return part;
  });
}

function markdownAnswer(text) {
  const blocks = [];
  let items = [];
  const flushList = () => {
    if (items.length) blocks.push(h('ul', {}, items.map((item) => h('li', {}, inlineMarkdown(item)))));
    items = [];
  };
  for (const line of String(text).split(/\r?\n/)) {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) { items.push(bullet[1]); continue; }
    flushList();
    if (!line.trim()) continue;
    const heading = line.match(/^\s*#{1,3}\s+(.+)$/);
    blocks.push(heading ? h('h4', {}, inlineMarkdown(heading[1])) : h('p', {}, inlineMarkdown(line)));
  }
  flushList();
  return h('div', { class: 'assistant-markdown' }, blocks);
}

export function assistant(ctx) {
  const conversation = [];
  const messages = h('div', { class: 'assistant-messages', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const suggestions = h('div', { class: 'assistant-suggestions' });
  const input = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Ask about a payment, mandate or proof…', 'aria-label': 'Your question', onkeydown: (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      input.form?.requestSubmit();
    }
  } });
  input.addEventListener('input', () => input.setCustomValidity(''));
  const send = h('button', { class: 'primary assistant-send', type: 'submit', 'aria-label': 'Send question' }, icon('play', 16));
  const panel = h('section', { class: 'assistant-panel panel', role: 'dialog', 'aria-label': 'LedgerTrue AI assistant', hidden: true },
    h('header', { class: 'assistant-head' },
      h('div', { class: 'assistant-brand' }, h('span', { class: 'assistant-mark' }, icon('shield', 16)), h('span', {}, h('strong', {}, 'LedgerTrue AI'), h('small', {}, 'Read-only · grounded in your records'))),
      h('div', { class: 'assistant-head-actions' },
        h('button', { class: 'ghost assistant-clear', type: 'button', onclick: () => {
          conversation.length = 0;
          clear(messages);
          suggestions.hidden = false;
          addMessage('assistant', 'Hello. I can explain current mandate and payment records, reconciliation alerts, and proof verification. I cannot approve or move money.', null, false);
        } }, 'Clear'),
        h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close assistant', onclick: () => { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); } }, icon('x', 18)))),
    messages,
    suggestions,
    h('form', { class: 'assistant-compose', onsubmit: async (event) => {
      event.preventDefault();
      const question = input.value.trim();
      if (send.disabled) return;
      if (!question) {
        input.setCustomValidity('Enter a question before sending.');
        input.reportValidity();
        input.focus();
        return;
      }
      input.value = '';
      suggestions.hidden = true;
      addMessage('user', question);
      send.disabled = true;
      input.disabled = true;
      const waiting = h('div', { class: 'assistant-message assistant-wait', role: 'status' }, 'LedgerTrue is thinking…');
      messages.append(waiting);
      messages.scrollTop = messages.scrollHeight;
      try {
        const history = conversation.slice(0, -1).slice(-6).map((message) => ({ role: message.role, content: message.content.slice(0, 500) }));
        const result = await api('POST', '/api/assistant/chat', { question, history });
        waiting.remove();
        addMessage('assistant', result.answer, result);
      } catch (error) {
        waiting.remove();
        addMessage('assistant', `I couldn’t reach the LedgerTrue assistant. Your records have not changed. ${error.message} You can still review mandates and reconciliation directly.`, { source: 'offline', sources: [] });
      } finally {
        send.disabled = false;
        input.disabled = false;
        input.focus();
      }
    } },
      input,
      h('div', { class: 'assistant-compose-foot' },
        h('div', { class: 'assistant-compose-copy' },
          h('span', { class: 'small assistant-ai-disclaimer' }, 'AI can make mistakes. Verify important details against the records.'),
          h('span', { class: 'muted small' }, 'Explanations only. Payment actions require separate controls.')),
        send)));
  const launcher = h('button', { class: 'assistant-launcher', type: 'button', 'aria-label': 'Open LedgerTrue AI assistant', 'aria-expanded': 'false', onclick: () => {
    panel.hidden = !panel.hidden;
    launcher.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) input.focus();
  } }, icon('chat', 20), h('span', {}, 'Ask LedgerTrue'));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      panel.hidden = true;
      launcher.setAttribute('aria-expanded', 'false');
      launcher.focus();
    }
  });

  function addMessage(role, text, result = null, remember = true) {
    if (remember) conversation.push({ role, content: text });
    const bubble = h('article', { class: `assistant-message ${role}` },
      role === 'assistant' ? h('span', { class: 'assistant-ai-label' }, result?.source === 'nvidia' ? (result?.tools?.length ? 'NVIDIA NIM · calculated from your records' : 'NVIDIA NIM · grounded explanation') : result?.source === 'offline' ? 'Offline help' : result?.source === 'deterministic' && result?.sources?.some((source) => source.kind !== 'system') ? 'Verified record · deterministic' : result?.screened ? 'Safety response' : 'LedgerTrue guide') : null,
      role === 'assistant' ? markdownAnswer(text) : h('p', {}, text));
    if (role === 'assistant' && result?.recordFacts?.length) {
      bubble.append(h('section', { class: 'assistant-record-facts', 'aria-label': 'Verified record facts' },
        result.recordFacts.map((fact) => {
          if (fact.kind === 'payment') {
            return h('div', { class: 'assistant-record-fact' },
              h('strong', {}, fact.state === 'VERIFIED' ? 'VERIFIED PAYMENT RECORD' : 'PAYMENT RECORD'),
              h('div', { class: 'mono' }, fact.paymentId),
              h('p', {}, `Status: ${fact.state}`),
              h('p', {}, `Amount: ${fact.amountCents} ${fact.currency} cents (${fact.amountDisplay})`),
              h('p', {}, `PayPal API confirmation: ${fact.confirmed ? 'confirmed' : 'not confirmed'}`),
              fact.ghost ? h('p', {}, 'Reconciliation: ghost-balance recovery detected.') : null,
              fact.duplicateCount ? h('p', {}, `Duplicate deliveries absorbed: ${fact.duplicateCount}`) : null,
              fact.recommended ? h('p', {}, `Recommended action: ${fact.recommended}`) : null);
          }
          return h('div', { class: 'assistant-record-fact' },
            h('strong', {}, 'MANDATE RECORD'),
            h('div', {}, fact.title),
            h('p', {}, `Budget: ${fact.budgetDisplay}`),
            h('p', {}, `Available: ${fact.availableDisplay}`),
            h('p', {}, `Status: ${fact.revoked ? 'revoked' : 'active'}${fact.quarantined ? ' · integrity check failed' : ''}`));
        })));
    }
    if (role === 'assistant' && result?.cards?.length) {
      bubble.append(h('section', { class: 'assistant-record-facts', 'aria-label': 'Calculated figures' },
        result.cards.map((card) => h('div', { class: 'assistant-record-fact' },
          h('strong', {}, card.title),
          card.rows.map(([k, v]) => h('p', {}, `${k}: ${v}`))))));
    }
    if (role === 'assistant' && result?.tools?.length) {
      bubble.append(h('p', { class: 'assistant-provider-notice', role: 'status' }, 'Figures were calculated by LedgerTrue from your records (read-only). Rule-based flags are for review, not confirmed fraud.'));
    }
    if (role === 'assistant' && result?.general) {
      bubble.append(h('p', { class: 'assistant-provider-notice', role: 'status' }, 'General information, not from your LedgerTrue records and not financial advice. Check your bank or PayPal for current terms.'));
    }
    if (role === 'assistant' && result?.providerStatus && result.providerStatus !== 'ready') {
      const notice = result.providerStatus === 'unavailable'
        ? 'NVIDIA NIM is unavailable. This is a deterministic response from LedgerTrue records.'
        : result.providerStatus === 'rejected'
          ? 'The NVIDIA response could not be verified. LedgerTrue returned a deterministic answer instead.'
        : result.providerStatus === 'disabled'
          ? 'NVIDIA NIM is disabled. This is a deterministic response from LedgerTrue records.'
          : 'NVIDIA NIM is not configured. This is a deterministic response from LedgerTrue records.';
      bubble.append(h('p', { class: 'assistant-provider-notice', role: 'status' }, notice));
    }
    if (result?.sources?.length) {
      bubble.append(h('div', { class: 'assistant-sources' },
        h('span', { class: 'muted small' }, 'Sources'),
        result.sources.map((source) => source.kind === 'mandate'
          ? h('a', { href: `#/m/${encodeURIComponent(source.id)}` }, source.label)
          : source.kind === 'payment'
            ? h('a', { href: '#/reconcile' }, source.label)
            : h('span', { class: 'assistant-source-tag' }, source.label))));
    }
    messages.append(bubble);
    messages.scrollTop = messages.scrollHeight;
  }

  addMessage('assistant', 'Hello. I can explain current mandate and payment records, reconciliation alerts, and proof verification. I cannot approve or move money.', null, false);
  clear(suggestions, SUGGESTIONS.map((question) => h('button', { type: 'button', onclick: () => { input.value = question; input.focus(); } }, question)));
  document.body.append(panel, launcher);
  return { destroy: () => { panel.remove(); launcher.remove(); } };
}

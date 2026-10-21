'use strict';

/**
 * Minimal DSML / canonical XML tool-call sieve (inspired by ds2api).
 * - Detects <|DSML|tool_calls>… and <tool_calls>… blocks
 * - Strips them from visible content
 * - Parses invoke/parameter into OpenAI tool_calls shape
 */

const OPEN_RE = /<\s*(?:\|?\s*DSML\s*\|?\s*)?tool_calls\b[^>]*>/i;
const CLOSE_RE = /<\/\s*(?:\|?\s*DSML\s*\|?\s*)?tool_calls\s*>/i;

function normalizeDsmlShell(text) {
  if (!text) return '';
  let s = String(text);
  // Common DSML drift → canonical XML tags
  s = s.replace(/<\s*\|?\s*DSML\s*\|?\s*tool_calls\b/gi, '<tool_calls');
  s = s.replace(/<\/\s*\|?\s*DSML\s*\|?\s*tool_calls\s*>/gi, '</tool_calls>');
  s = s.replace(/<\s*\|?\s*DSML\s*\|?\s*invoke\b/gi, '<invoke');
  s = s.replace(/<\/\s*\|?\s*DSML\s*\|?\s*invoke\s*>/gi, '</invoke>');
  s = s.replace(/<\s*\|?\s*DSML\s*\|?\s*parameter\b/gi, '<parameter');
  s = s.replace(/<\/\s*\|?\s*DSML\s*\|?\s*parameter\s*>/gi, '</parameter>');
  // Fullwidth / odd brackets
  s = s.replace(/[〈]/g, '<').replace(/[〉]/g, '>');
  return s;
}

function stripCdata(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .trim();
}

function parseParamBody(body) {
  const t = stripCdata(body);
  if (!t) return '';
  // try JSON
  if (/^[\[{]/.test(t) || /^(true|false|null|-?\d+(\.\d+)?)$/i.test(t)) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  return t;
}

function parseToolCallsBlock(block) {
  const norm = normalizeDsmlShell(block);
  const calls = [];
  const invokeRe =
    /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
  let m;
  while ((m = invokeRe.exec(norm))) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const nameMatch = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const name = (nameMatch && nameMatch[1]) || '';
    if (!name) continue;
    const args = {};
    const paramRe =
      /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
    let pm;
    while ((pm = paramRe.exec(inner))) {
      const pattrs = pm[1] || '';
      const pbody = pm[2] || '';
      const pname = (pattrs.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!pname) continue;
      args[pname] = parseParamBody(pbody);
    }
    calls.push({
      id: 'call_' + Math.random().toString(36).slice(2, 12),
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    });
  }
  return calls;
}

function extractToolCalls(fullText) {
  const text = String(fullText || '');
  const norm = normalizeDsmlShell(text);
  const calls = [];
  let visible = text;
  // Find all tool_calls blocks
  const blockRe = /<\s*tool_calls\b[^>]*>[\s\S]*?<\/\s*tool_calls\s*>/gi;
  const normBlocks = norm.match(blockRe) || [];
  for (const b of normBlocks) {
    calls.push(...parseToolCallsBlock(b));
  }
  if (calls.length) {
    // Strip tool blocks from original (best-effort on original + normalized)
    visible = normalizeDsmlShell(text).replace(blockRe, '').trim();
  }
  return { tool_calls: calls, content: visible };
}

function buildToolInstructions(tools) {
  const names = (tools || [])
    .map((t) => (t && t.function && t.function.name) || (t && t.name) || '')
    .filter(Boolean);
  const nameList = names.length ? names.join(', ') : 'the tools listed in the schema';
  return (
    `TOOL CALL FORMAT — FOLLOW EXACTLY when you need a tool (${nameList}):\n\n` +
    `<|DSML|tool_calls>\n` +
    `  <|DSML|invoke name="TOOL_NAME">\n` +
    `    <|DSML|parameter name="ARG"><![CDATA[VALUE]]></|DSML|parameter>\n` +
    `  </|DSML|invoke>\n` +
    `</|DSML|tool_calls>\n\n` +
    `Rules: use CDATA for string values; do not wrap in markdown fences; ` +
    `if you call a tool, start the tool block with <|DSML|tool_calls>. ` +
    `Otherwise answer the user in plain text with no tool XML.\n`
  );
}

/**
 * Streaming buffer: holds back output once a tool-call opener is seen.
 */
class StreamToolSieve {
  constructor(enabled) {
    this.enabled = !!enabled;
    this.buf = '';
    this.hold = false;
    this.releasedText = '';
  }

  /** @returns {{ flush: string, hold: boolean }} text safe to emit now */
  push(chunk) {
    if (!this.enabled) return { flush: chunk || '', hold: false };
    if (!chunk) return { flush: '', hold: this.hold };
    this.buf += chunk;
    if (!this.hold) {
      const norm = normalizeDsmlShell(this.buf);
      const idx = norm.search(OPEN_RE);
      if (idx === -1) {
        // Keep a small tail in case opener is split across chunks
        if (this.buf.length > 64) {
          const flush = this.buf.slice(0, -64);
          this.buf = this.buf.slice(-64);
          this.releasedText += flush;
          return { flush, hold: false };
        }
        return { flush: '', hold: false };
      }
      this.hold = true;
      // Emit only text before opener
      const before = this.buf.slice(0, Math.max(0, idx));
      this.buf = this.buf.slice(Math.max(0, idx));
      this.releasedText += before;
      return { flush: before, hold: true };
    }
    return { flush: '', hold: true };
  }

  finalize() {
    if (!this.enabled) {
      return { content: this.buf, tool_calls: [], held: false };
    }
    // Flush remaining if no tool block completed
    const full = this.releasedText + this.buf;
    const parsed = extractToolCalls(full);
    if (parsed.tool_calls.length) {
      return {
        content: parsed.content,
        tool_calls: parsed.tool_calls,
        held: true,
      };
    }
    // No tools — release any held buffer as content
    return {
      content: this.hold ? this.buf : '',
      tool_calls: [],
      held: this.hold,
      leftover: this.hold ? this.buf : '',
    };
  }
}

module.exports = {
  buildToolInstructions,
  extractToolCalls,
  StreamToolSieve,
  normalizeDsmlShell,
};

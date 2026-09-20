'use strict';
// Small, dependency-free Markdown subset. Raw HTML and executable URLs are text.
(() => {
  const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function inline(text) {
    const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
    let out = '', last = 0, match;
    while ((match = pattern.exec(text))) {
      out += escape(text.slice(last, match.index)); last = pattern.lastIndex;
      if (match[1] !== undefined) out += '<code>' + escape(match[1]) + '</code>';
      else if (match[2] !== undefined) out += '<strong>' + escape(match[2]) + '</strong>';
      else {
        let safe = false; try { const u = new URL(match[4]); safe = ['https:', 'http:'].includes(u.protocol); } catch {}
        out += safe ? '<a href="' + escape(match[4]) + '" target="_blank" rel="noopener noreferrer">' + escape(match[3]) + '</a>' : '<span class="chat-reference" title="' + escape(match[4]) + '">' + escape(match[3]) + '</span><code class="chat-path">' + escape(match[4]) + '</code>';
      }
    }
    return out + escape(text.slice(last));
  }
  function format(text) {
    return String(text || '').split(/```[^\n]*\n([\s\S]*?)```/g).map((part, index) => {
      if (index % 2) return '<pre><code>' + escape(part) + '</code></pre>';
      let list = '', out = '';
      for (const line of part.split('\n')) {
        const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/), heading = line.match(/^#{1,6}\s+(.+)$/);
        if (bullet) { if (!list) { out += '<ul>'; list = 'ul'; } out += '<li>' + inline(bullet[1]) + '</li>'; continue; }
        if (list) { out += '</ul>'; list = ''; }
        out += heading ? '<h4>' + inline(heading[1]) + '</h4>' : line ? '<div class="message-line">' + inline(line) + '</div>' : '<div class="message-gap"></div>';
      }
      return out + (list ? '</ul>' : '');
    }).join('');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { format }; else window.ChatFormat = { format };
})();

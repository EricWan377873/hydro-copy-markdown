// ==UserScript==
// @name         Hydro 复制题目 Markdown（通用兼容版）
// @namespace    hydro-copy-markdown
// @version      1.6.0
// @description  兼容 Hydro 题库、比赛、作业、只读/已结束页面和未登录状态，优先复制原始 Markdown
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const BUTTON_ID = 'hydro-copy-markdown-button';
    const ITEM_ATTR = 'data-hydro-copy-markdown-item';
    const DESCRIPTION = '[data-fragment-id="problem-description"]';
    const SIDEBAR = '.section--problem-sidebar';
    let injectTimer = null;
    let currentPageKey = '';
    let boundButton = null;

    // Only run on a recognisable Hydro problem page. Do not require an IDE,
    // submit action, logged-in user or a particular data-page variant.
    function getProblemContext() {
        const root = document.documentElement;
        const content = document.querySelector('.problem-content ' + DESCRIPTION) ||
            document.querySelector(DESCRIPTION) ||
            document.querySelector('.problem-content .section__body.richmedia, .problem-content .typo');
        if (!root || !content) return null;

        const page = root.getAttribute('data-page') || '';
        const hydro = root.getAttribute('data-app') === 'Hydro' ||
            /(?:^|_)(?:problem_detail|detail_problem)$/.test(page) &&
            !!document.querySelector('script[src*="hydro"], a[name^="problem-sidebar__"]');
        if (!hydro) return null;

        const sidebar = document.querySelector(SIDEBAR);
        const menu = sidebar?.querySelector('ol.menu, ul.menu, .menu') || null;
        if (!menu) {
            // Modified Hydro themes occasionally omit the standard sidebar.
            // Still offer a small fixed action instead of silently disappearing.
            return { content, sidebar, menu: null, before: null,
                anchorType: 'floating' };
        }

        // Different Hydro versions and states have very different sidebars:
        // IDE entry, ordinary submission, sign-in submission, bank link after
        // a contest, built-in "Copy" action, or only a generic menu item.
        const links = Array.from(menu.querySelectorAll('a.menu__link'))
            .filter(a => a.id !== BUTTON_ID && !a.closest('[' + ITEM_ATTR + ']'));
        const isSubmit = a => {
            try {
                const url = new URL(a.getAttribute('href'), location.href);
                return url.origin === location.origin &&
                    /(?:^|\/)p\/[^/]+\/submit\/?$/.test(url.pathname);
            } catch (_) { return false; }
        };
        const isBank = a => {
            try {
                const url = new URL(a.getAttribute('href'), location.href);
                return url.origin === location.origin &&
                    /(?:^|\/)p\/[^/]+\/?$/.test(url.pathname) &&
                    !url.searchParams.has('tid');
            } catch (_) { return false; }
        };
        const anchor =
            links.find(a => a.getAttribute('name') === 'problem-sidebar__open-scratchpad') ||
            links.find(isSubmit) ||
            links.find(a => /showSignInDialog/i.test(a.getAttribute('href') || '')) ||
            links.find(a => /登录后递交|sign\s*in\s*to\s*submit/i.test(a.textContent || '')) ||
            links.find(isBank) ||
            links.find(a => a.getAttribute('name') === 'problem-sidebar__copy') ||
            links[0] || null;
        const item = anchor && anchor.closest('li');
        const firstItem = Array.from(menu.children)
            .find(x => x.tagName === 'LI' && !x.hasAttribute(ITEM_ATTR)) || null;
        return {
            content, sidebar, menu,
            before: item && item.parentNode === menu ? item : firstItem,
            anchorType: anchor ? (anchor.getAttribute('name') ||
                (isSubmit(anchor) ? 'submit' : isBank(anchor) ? 'bank' : 'other')) : 'menu'
        };
    }

    function renderedLanguage(data) {
        const candidates = [
            data && data.activeLang,
            new URL(location.href).searchParams.get('lang'),
            document.querySelector('select[name="lang"]')?.value,
            document.documentElement.getAttribute('lang'),
            document.querySelector('meta[property="og:locale"]')?.getAttribute('content'),
            data && data.preferredLang
        ];
        return candidates.find(x => typeof x === 'string' && x.trim()) || 'zh';
    }

    function selectLocalizedContent(content, lang) {
        let data = content;
        if (typeof data === 'string' && /^\s*\{/.test(data)) {
            try {
                const parsed = JSON.parse(data);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
            } catch (_) { /* A normal Markdown string can also start with '{'. */ }
        }
        if (typeof data === 'string') return data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const keys = Object.keys(data).filter(k => typeof data[k] === 'string');
        const langCode = (lang || '').replace(/_/g, '-').toLowerCase();
        const requested = [langCode, langCode.split('-')[0], 'zh', 'en'];
        for (const name of requested) {
            const matched = keys.find(k => k.replace(/_/g, '-').toLowerCase() === name);
            if (matched) return data[matched];
        }
        return keys.length ? data[keys[0]] : null;
    }

    // The modern Hydro page embeds:
    //   window.UiContextNew = '{"pdoc":{"content":"..."}, ...}';
    // With @grant GM_setClipboard userscripts may be in an isolated realm, so
    // window.UiContextNew cannot be relied upon. Decode ONLY the quoted JS
    // string literal; never eval/Function/execute arbitrary page scripts.
    function decodeQuotedJS(source, quoteIndex) {
        const quote = source[quoteIndex];
        if (quote !== '\'' && quote !== '"') return null;
        let result = '';
        for (let i = quoteIndex + 1; i < source.length; i++) {
            let ch = source[i];
            if (ch === quote) return result;
            if (ch !== '\\') { result += ch; continue; }
            if (++i >= source.length) return null;
            ch = source[i];
            if (ch === '\n') continue;
            if (ch === '\r') { if (source[i + 1] === '\n') i++; continue; }
            const control = { 'n': '\n', 'r': '\r', 't': '\t', 'b': '\b',
                'f': '\f', 'v': '\v', '0': '\0' };
            if (Object.prototype.hasOwnProperty.call(control, ch)) {
                result += control[ch];
            } else if (ch === 'x' && /^[0-9a-fA-F]{2}$/.test(source.slice(i + 1, i + 3))) {
                result += String.fromCharCode(parseInt(source.slice(i + 1, i + 3), 16));
                i += 2;
            } else if (ch === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 1, i + 5))) {
                result += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16));
                i += 4;
            } else if (ch === 'u' && source[i + 1] === '{') {
                const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(source.slice(i + 1));
                if (m && parseInt(m[1], 16) <= 0x10FFFF) {
                    result += String.fromCodePoint(parseInt(m[1], 16));
                    i += m[0].length;
                } else result += ch;
            } else {
                result += ch;
            }
        }
        return null;
    }

    function pageProblemIds() {
        const m = /(?:^|\/)p\/([^/?#]+)\/?$/.exec(location.pathname);
        if (!m) return [];
        try { return [decodeURIComponent(m[1])]; } catch (_) { return [m[1]]; }
    }

    function matchesPage(data) {
        if (!data || typeof data !== 'object' || !data.pdoc) return false;
        const ids = pageProblemIds();
        if (!ids.length) return true;
        const pdoc = data.pdoc;
        return [data.problemId, data.problemNumId, pdoc.docId, pdoc.pid]
            .filter(x => x !== undefined && x !== null)
            .some(id => ids.includes(String(id)));
    }

    function readEmbeddedContext() {
        const scripts = document.querySelectorAll('script:not([src])');
        // Newer PJAX fragments can append a new script, leaving older scripts
        // in the document. Prefer the last one that matches the URL's problem.
        for (let i = scripts.length - 1; i >= 0; i--) {
            const text = scripts[i].textContent || '';
            if (!text.includes('UiContextNew')) continue;
            const pattern = /\b(?:window\.)?UiContextNew\s*=\s*(['"])/g;
            let match;
            while ((match = pattern.exec(text))) {
                const literal = decodeQuotedJS(text, match.index + match[0].length - 1);
                if (literal === null) continue;
                try {
                    const data = JSON.parse(literal);
                    if (matchesPage(data)) return data;
                } catch (_) { /* Try the next inline script / PJAX. */ }
            }
        }
        return null;
    }

    function statementMarkdown(data) {
        if (!data || !Array.isArray(data.statements)) return null;
        const statements = data.statements.filter(s => s && typeof s.content === 'string' && s.content.trim());
        if (!statements.length) return null;
        const lang = (renderedLanguage(data) || '').toLowerCase().replace(/_/g, '-');
        let sameLang = statements.filter(s => (s.lang || '').toLowerCase().replace(/_/g, '-') === lang);
        if (!sameLang.length) sameLang = statements.filter(s =>
            (s.lang || '').toLowerCase().replace(/_/g, '-').split('-')[0] === lang.split('-')[0]);
        if (!sameLang.length) {
            const firstLang = statements[0].lang;
            sameLang = statements.filter(s => s.lang === firstLang);
        }
        return sameLang.map(s => {
            const name = (s.name || '').trim();
            const body = s.content.trim();
            return name && !new RegExp('^#{1,6}\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .test(body) ? '## ' + name + '\n\n' + body : body;
        }).join('\n\n').trim();
    }

    // Prefer original pdoc.content; modern split statement entries are used
    // when the original field is empty. pdoc.content can be a JSON object
    // keyed by language.
    function extractMarkdown(data) {
        if (!data || typeof data !== 'object') return null;
        const raw = data.raw && typeof data.raw === 'object' ? data.raw : data;
        const nested = raw.data && typeof raw.data === 'object' ? raw.data : null;
        for (const ctx of [raw, nested, data].filter(Boolean)) {
            const pdoc = ctx.pdoc;
            if (pdoc) {
                const markdown = selectLocalizedContent(pdoc.content, renderedLanguage(ctx));
                if (typeof markdown === 'string' && markdown.trim()) {
                    if (pdoc.html === true || /^\s*<(?:!doctype\s+html|html\b|div\b|p\b|h[1-6]\b|section\b)/i.test(markdown)) {
                        return { text: convertHTML(markdown), source: 'converted' };
                    }
                    return { text: markdown, source: 'raw' };
                }
            }
            const stmts = statementMarkdown(ctx);
            if (stmts) return { text: stmts, source: 'raw' };
        }
        return null;
    }

    async function fetchPjax(url, flag) {
        const target = new URL(url, location.href);
        if (target.origin !== location.origin) throw new Error('不允许跨站读取题面');
        target.hash = '';
        target.searchParams.set('pjax', flag);
        const response = await fetch(target.href, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                Accept: 'application/json, text/plain, */*',
                'X-Requested-With': 'Fetch',
                'X-PJAX': 'true'
            }
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const body = await response.text();
        try {
            return JSON.parse(body);
        } catch (_) {
            // Some heavily customised instances reply with full HTML instead.
            const doc = new DOMParser().parseFromString(body, 'text/html');
            const script = Array.from(doc.scripts).find(s => (s.textContent || '').includes('UiContextNew'));
            if (script) {
                const source = script.textContent;
                const m = /\b(?:window\.)?UiContextNew\s*=\s*(['"])/.exec(source);
                if (m) {
                    const literal = decodeQuotedJS(source, m.index + m[0].length - 1);
                    if (literal !== null) return JSON.parse(literal);
                }
            }
            throw new Error('PJAX 返回的不是可识别的题目 JSON');
        }
    }

    function findBankUrl(ctx) {
        if (!ctx.sidebar) return null;
        for (const a of ctx.sidebar.querySelectorAll('a[href]')) {
            try {
                const url = new URL(a.getAttribute('href'), location.href);
                if (url.origin === location.origin &&
                    /(?:^|\/)p\/[^/]+\/?$/.test(url.pathname) &&
                    !url.searchParams.has('tid')) return url.href;
            } catch (_) { /* Invalid href. */ }
        }
        return null;
    }

    function normalizeSpace(text) { return (text || '').replace(/\s+/g, ' '); }
    function trimNewlines(text) { return text.replace(/\n{3,}/g, '\n\n').trim(); }

    // Last resort for instances that do not expose source data to the viewer:
    // convert only the VISIBLE problem description (not the whole page).
    // No network requests to third-party Markdown conversion services.
    function convertHTML(htmlOrNode) {
        const container = typeof htmlOrNode === 'string'
            ? new DOMParser().parseFromString(htmlOrNode, 'text/html').body
            : htmlOrNode;
        if (!container) return '';

        function inline(node) {
            if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/[\t\r\n ]+/g, ' ');
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            const tag = node.tagName.toLowerCase();
            if (['script', 'style', 'noscript', 'button'].includes(tag)) return '';
            // KaTeX / MathJax render LaTeX with many decorative DOM nodes.
            if (node.classList.contains('katex')) {
                const ann = node.querySelector('annotation[encoding="application/x-tex"]');
                if (ann) return '$' + ann.textContent + '$';
            }
            if (tag === 'img') {
                const src = node.getAttribute('src') || '';
                let url = src;
                try { url = new URL(src, location.href).href; } catch (_) { /* Keep original. */ }
                return '![' + (node.getAttribute('alt') || '').replace(/]/g, '\\]') + '](' + url + ')';
            }
            if (tag === 'br') return '\n';
            const inner = Array.from(node.childNodes).map(inline).join('');
            if (tag === 'code' && node.parentElement?.tagName !== 'PRE') return '`' + inner.trim().replace(/`/g, '\\`') + '`';
            if (tag === 'strong' || tag === 'b') return '**' + inner.trim() + '**';
            if (tag === 'em' || tag === 'i') return '*' + inner.trim() + '*';
            if (tag === 'del' || tag === 's') return '~~' + inner.trim() + '~~';
            if (tag === 'a' && node.getAttribute('href')) {
                let href = node.getAttribute('href');
                try { href = new URL(href, location.href).href; } catch (_) { /* Keep relative. */ }
                return '[' + inner.trim() + '](' + href + ')';
            }
            if (tag === 'sup') return '^{' + inner.trim() + '}';
            if (tag === 'sub') return '_{' + inner.trim() + '}';
            return inner;
        }

        function block(node, depth) {
            if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.trim() ? inline(node) : '';
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            const tag = node.tagName.toLowerCase();
            if (['script', 'style', 'noscript'].includes(tag)) return '';
            if (node.classList.contains('katex-display')) {
                const ann = node.querySelector('annotation[encoding="application/x-tex"]');
                if (ann) return '\n\n$$\n' + ann.textContent + '\n$$\n\n';
            }
            if (node.classList.contains('note') && /比赛已结束|contest (?:has )?ended/i.test(node.textContent)) return '';
            if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + inline(node).trim() + '\n\n';
            if (tag === 'pre') {
                const code = node.querySelector('code');
                const langMatch = (code?.className || '').match(/(?:language|lang)-([\w+-]+)/);
                const body = (code || node).textContent.replace(/\n$/, '');
                const fences = body.match(/`{3,}/g) || [];
                const fence = '`'.repeat(Math.max(3, ...fences.map(x => x.length + 1)));
                return '\n\n' + fence + (langMatch ? langMatch[1] : '') + '\n' + body + '\n' + fence + '\n\n';
            }
            if (tag === 'p') return '\n\n' + inline(node).trim() + '\n\n';
            if (tag === 'hr') return '\n\n---\n\n';
            if (tag === 'blockquote') {
                return '\n\n' + trimNewlines(Array.from(node.childNodes).map(n => block(n, depth)).join(''))
                    .split('\n').map(line => '> ' + line).join('\n') + '\n\n';
            }
            if (tag === 'ul' || tag === 'ol') {
                let i = Number(node.getAttribute('start') || 1);
                const entries = Array.from(node.children).filter(n => n.tagName === 'LI').map(li => {
                    const content = trimNewlines(Array.from(li.childNodes).map(n =>
                        ['UL', 'OL'].includes(n.tagName) ? '\n' + block(n, depth + 1) :
                            n.tagName === 'P' ? inline(n).trim() : inline(n)).join(''));
                    const marker = tag === 'ol' ? (i++) + '. ' : '- ';
                    return '  '.repeat(depth) + marker + content.replace(/\n/g, '\n' + '  '.repeat(depth + 1));
                });
                return '\n' + entries.join('\n') + '\n';
            }
            if (tag === 'table') {
                const rows = Array.from(node.querySelectorAll('tr')).map(tr =>
                    Array.from(tr.children).filter(c => /^(TH|TD)$/.test(c.tagName))
                        .map(cell => normalizeSpace(inline(cell)).trim().replace(/\|/g, '\\|')));
                if (!rows.length) return '';
                const size = Math.max(...rows.map(r => r.length));
                const row = r => '| ' + Array.from({ length: size }, (_, i) => r[i] || '').join(' | ') + ' |';
                return '\n\n' + [row(rows[0]), row(Array(size).fill('---')),
                    ...rows.slice(1).map(row)].join('\n') + '\n\n';
            }
            if (['img', 'code', 'span', 'a', 'b', 'strong', 'em', 'i', 'br'].includes(tag)) return inline(node);
            return Array.from(node.childNodes).map(n => block(n, depth)).join('');
        }
        return trimNewlines(Array.from(container.childNodes).map(n => block(n, 0)).join(''));
    }

    async function getMarkdown(ctx) {
        const embedded = readEmbeddedContext();
        const first = extractMarkdown(embedded);
        if (first?.text.trim()) return first;

        const urls = [location.href];
        const bank = findBankUrl(ctx);
        if (bank && bank !== location.href) urls.push(bank);
        const errors = [];
        for (const url of urls) {
            for (const flag of ['1', 'true']) {
                try {
                    const data = await fetchPjax(url, flag);
                    const extracted = extractMarkdown(data);
                    if (extracted?.text.trim()) return extracted;
                    errors.push('没有可用的 pdoc.content 或 statements：' + url);
                } catch (err) { errors.push(url + ' [?pjax=' + flag + '] ' + err.message); }
            }
        }
        // This is intentionally the final fallback: preserve original raw
        // Markdown whenever Hydro provides it, rather than reverse-rendering.
        const fallback = convertHTML(ctx.content);
        if (fallback.trim()) {
            console.warn('[Hydro Copy Markdown] 原始数据不可用，已使用页面题面转换。', errors);
            return { text: fallback, source: 'converted' };
        }
        throw new Error(errors[errors.length - 1] || '未找到可复制的题面内容');
    }

    async function copyText(text) {
        if (typeof GM_setClipboard === 'function') {
            await GM_setClipboard(text, 'text');
            return;
        }
        if (navigator.clipboard?.writeText) {
            try { await navigator.clipboard.writeText(text); return; } catch (_) { /* Old HTTP sites. */ }
        }
        // Some Hydro instances run on HTTP and block navigator.clipboard.
        const input = document.createElement('textarea');
        input.value = text;
        input.setAttribute('readonly', '');
        input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(input);
        input.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } finally { input.remove(); }
        if (!copied) throw new Error('浏览器拒绝访问剪贴板');
    }

    function pageKey() {
        return location.pathname + location.search + '|' +
            (document.documentElement.getAttribute('data-page') || '');
    }

    function removeInjectedButton() {
        document.querySelectorAll('[' + ITEM_ATTR + ']').forEach(el => el.remove());
        boundButton = null;
    }

    function makeButton(ctx) {
        const item = document.createElement(ctx.menu ? 'li' : 'div');
        item.className = ctx.menu ? 'menu__item' : 'hydro-copy-markdown-floating';
        item.setAttribute(ITEM_ATTR, '1');
        const a = document.createElement('a');
        a.id = BUTTON_ID;
        a.className = 'menu__link';
        a.href = '#';
        a.title = '复制当前题面的原始 Markdown';
        if (!ctx.menu) {
            a.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483640;' +
                'display:inline-block;padding:10px 15px;border-radius:8px;' +
                'background:#396c9d;color:white;box-shadow:0 3px 12px #0003;' +
                'font-size:14px;text-decoration:none;cursor:pointer';
        }
        const icon = document.createElement('span');
        icon.className = 'icon icon-copy';
        a.appendChild(icon);
        a.appendChild(document.createTextNode(' '));
        const label = document.createElement('span');
        label.textContent = '复制 Markdown';
        a.appendChild(label);
        item.appendChild(a);
        boundButton = a;
        if (ctx.menu) ctx.menu.insertBefore(item, ctx.before);
        else document.body.appendChild(item);

        a.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            if (a.dataset.copying === '1') return;
            a.dataset.copying = '1';
            const requestKey = pageKey();
            label.textContent = '正在复制…';
            try {
                const result = await getMarkdown(ctx);
                if (requestKey !== pageKey()) throw new Error('页面已切换，请重新点击复制');
                await copyText(result.text);
                label.textContent = result.source === 'raw' ? '已复制 ✓' : '已复制（题面转换）✓';
                a.title = result.source === 'raw'
                    ? '已复制原始 Markdown（' + result.text.length + ' 字符）'
                    : '已复制从可见题面转换的 Markdown（原始数据不可用）';
            } catch (err) {
                console.error('[Hydro Copy Markdown] 复制失败：', err);
                label.textContent = '复制失败';
                a.title = '复制失败：' + (err?.message || String(err));
            } finally {
                delete a.dataset.copying;
                setTimeout(() => {
                    if (a.isConnected && a.dataset.copying !== '1') {
                        label.textContent = '复制 Markdown';
                        a.title = '复制当前题面的原始 Markdown';
                    }
                }, 2300);
            }
        });
    }

    function inject() {
        const ctx = getProblemContext();
        if (!ctx) { removeInjectedButton(); return; }
        const key = pageKey();
        const existing = document.getElementById(BUTTON_ID);
        const existingItem = existing?.closest('[' + ITEM_ATTR + ']');
        const parent = ctx.menu || document.body;
        const positioned = !ctx.menu || existingItem?.nextElementSibling === ctx.before;
        if (existing === boundButton && existingItem &&
            existingItem.parentNode === parent && positioned && currentPageKey === key) return;
        removeInjectedButton();
        currentPageKey = key;
        makeButton(ctx);
    }

    function scheduleInject() {
        if (injectTimer !== null) clearTimeout(injectTimer);
        injectTimer = setTimeout(() => { injectTimer = null; inject(); }, 50);
    }

    function start() {
        // @match is intentionally broad to support custom domains. Do not
        // observe or modify unrelated websites.
        if (document.documentElement.getAttribute('data-app') !== 'Hydro' &&
            !document.querySelector('.problem-content, .section--problem-sidebar')) return;
        inject();
        [150, 600, 1600].forEach(ms => setTimeout(inject, ms));
        // Hydro's PJAX may replace both the problem body and sidebar.
        new MutationObserver(scheduleInject).observe(document.documentElement, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['data-app', 'data-page']
        });
        window.addEventListener('popstate', scheduleInject);
        window.addEventListener('hashchange', scheduleInject);
        window.addEventListener('pjax:complete', scheduleInject);
        window.addEventListener('pjax:end', scheduleInject);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else start();
})();

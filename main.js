// ==UserScript==
// @name         Hydro 复制题目 Markdown
// @namespace    hydro-copy-markdown
// @version      1.5.0
// @description  在 Hydro 题目页（含比赛题和未登录状态）添加“复制 Markdown”按钮
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    var BUTTON_ID = 'hydro-copy-markdown-button';
    var ITEM_ATTR = 'data-hydro-copy-markdown-item';
    var injectTimer = null;

    // 找到“复制 Markdown”按钮应当插入到哪个菜单项之前。
    //
    // 已登录时优先使用：
    //   进入在线编程模式 (Alt+E)
    //
    // 未登录时使用：
    //   登录后递交
    function findSubmitAnchor() {
        var scratch = document.querySelector(
            'a[name="problem-sidebar__open-scratchpad"][data-global-hotkey="alt+e"], ' +
            'a[name="problem-sidebar__open-scratchpad"]'
        );

        if (scratch) {
            return {
                anchor: scratch,
                type: 'scratchpad'
            };
        }

        // Hydro 未登录状态目前使用：
        //
        // href="javascript:showSignInDialog();"
        //
        // 优先用这个结构识别，不依赖中文文本。
        var signIn = document.querySelector(
            '.section--problem-sidebar ' +
            'a.menu__link[href^="javascript:showSignInDialog"]'
        );

        // 给某些修改版 Hydro 留一个文字识别 fallback。
        if (!signIn) {
            var links = document.querySelectorAll(
                '.section--problem-sidebar a.menu__link'
            );

            for (var i = 0; i < links.length; i++) {
                var text = (links[i].textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim();

                if (text.indexOf('登录后递交') !== -1) {
                    signIn = links[i];
                    break;
                }
            }
        }

        if (signIn) {
            return {
                anchor: signIn,
                type: 'signin-submit'
            };
        }

        return null;
    }

    // 判断当前页面是不是我们需要处理的 Hydro 题目页。
    //
    // 不依赖：
    //   problem_detail
    //   contest_detail_problem
    //
    // 等 data-page 名字，避免 Hydro 新页面类型导致失效。
    function getProblemContext() {
        var root = document.documentElement;

        if (
            !root ||
            root.getAttribute('data-app') !== 'Hydro'
        ) {
            return null;
        }

        var content = document.querySelector(
            '.problem-content [data-fragment-id="problem-description"], ' +
            '[data-fragment-id="problem-description"]'
        );

        if (!content) {
            return null;
        }

        var submitAnchor = findSubmitAnchor();

        if (
            !submitAnchor ||
            !submitAnchor.anchor
        ) {
            return null;
        }

        var item = submitAnchor.anchor.closest
            ? submitAnchor.anchor.closest('li')
            : submitAnchor.anchor.parentElement;

        if (
            !item ||
            !item.parentNode
        ) {
            return null;
        }

        return {
            root: root,
            content: content,
            anchor: submitAnchor.anchor,
            anchorType: submitAnchor.type,
            item: item
        };
    }

    // 获取当前页面正在渲染的语言。
    function getRenderedLanguage() {
        var lang =
            document.documentElement &&
            document.documentElement.getAttribute('lang');

        if (
            lang &&
            lang.trim()
        ) {
            return lang.trim();
        }

        var meta = document.querySelector(
            'meta[property="og:locale"]'
        );

        if (
            meta &&
            meta.content &&
            meta.content.trim()
        ) {
            return meta.content.trim();
        }

        return null;
    }

    // 从 Hydro 的多语言 content 中选出最终 Markdown。
    //
    // 可能输入：
    //
    // 普通字符串：
    //   # Problem
    //
    // JSON 字符串：
    //   {"zh":"...","en":"..."}
    //
    // 或已经解析好的对象。
    //
    // 优先级：
    //   当前渲染语言
    //   基础语言
    //   zh
    //   en
    //   任意第一个字符串
    function selectLocalizedContent(content) {
        var value = content;

        if (typeof value === 'string') {
            var trimmed = value.trim();

            if (
                trimmed.charAt(0) === '{' &&
                trimmed.charAt(
                    trimmed.length - 1
                ) === '}'
            ) {
                try {
                    var parsed =
                        JSON.parse(trimmed);

                    if (
                        parsed &&
                        typeof parsed === 'object' &&
                        !Array.isArray(parsed)
                    ) {
                        value = parsed;
                    }
                } catch (e) {
                    // 普通 Markdown。
                }
            }
        }

        // 普通 Markdown 直接返回。
        if (typeof value === 'string') {
            return value;
        }

        if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value)
        ) {
            throw new Error(
                '无法识别题目 Markdown 数据格式'
            );
        }

        var candidates = [];
        var pageLang =
            getRenderedLanguage();

        if (pageLang) {
            candidates.push(pageLang);

            candidates.push(
                pageLang.replace(/_/g, '-')
            );

            candidates.push(
                pageLang.replace(/-/g, '_')
            );

            candidates.push(
                pageLang.toLowerCase()
            );

            var baseLang =
                pageLang
                    .replace(/_/g, '-')
                    .split('-')[0];

            if (baseLang) {
                candidates.push(baseLang);
            }
        }

        // 页面没有明确语言时按这个顺序 fallback。
        candidates.push('zh');
        candidates.push('en');

        var seen =
            Object.create(null);

        var unique = [];

        for (
            var i = 0;
            i < candidates.length;
            i++
        ) {
            var candidate =
                candidates[i];

            if (!seen[candidate]) {
                seen[candidate] = true;
                unique.push(candidate);
            }
        }

        // 精确匹配。
        for (
            var j = 0;
            j < unique.length;
            j++
        ) {
            var exact =
                unique[j];

            if (
                typeof value[exact] ===
                'string'
            ) {
                return value[exact];
            }
        }

        // 大小写不敏感匹配。
        var keys =
            Object.keys(value);

        for (
            var k = 0;
            k < unique.length;
            k++
        ) {
            var wanted =
                unique[k].toLowerCase();

            for (
                var m = 0;
                m < keys.length;
                m++
            ) {
                if (
                    keys[m].toLowerCase() ===
                        wanted &&
                    typeof value[keys[m]] ===
                        'string'
                ) {
                    return value[keys[m]];
                }
            }
        }

        // 任意第一个字符串。
        for (
            var n = 0;
            n < keys.length;
            n++
        ) {
            if (
                typeof value[keys[n]] ===
                'string'
            ) {
                return value[keys[n]];
            }
        }

        throw new Error(
            '题目中没有可用的语言内容'
        );
    }

    // 从几种可能的 Hydro PJAX JSON 结构中寻找 pdoc.content。
    function findContentInPjax(data) {
        if (
            !data ||
            typeof data !== 'object'
        ) {
            return null;
        }

        var candidates = [
            data.raw &&
                data.raw.pdoc &&
                data.raw.pdoc.content,

            data.pdoc &&
                data.pdoc.content,

            data.data &&
                data.data.raw &&
                data.data.raw.pdoc &&
                data.data.raw.pdoc.content,

            data.data &&
                data.data.pdoc &&
                data.data.pdoc.content
        ];

        for (
            var i = 0;
            i < candidates.length;
            i++
        ) {
            if (
                candidates[i] !== undefined &&
                candidates[i] !== null
            ) {
                return candidates[i];
            }
        }

        return null;
    }

    // 请求 Hydro 的原始题面数据。
    async function requestRawContent(
        baseUrl,
        pjaxValue
    ) {
        var url =
            new URL(
                baseUrl,
                location.href
            );

        url.hash = '';

        // 保留 tid 等现有参数，只加入 pjax。
        url.searchParams.set(
            'pjax',
            pjaxValue
        );

        var response =
            await fetch(
                url.href,
                {
                    method: 'GET',

                    credentials:
                        'same-origin',

                    cache:
                        'no-store',

                    headers: {
                        'Accept':
                            'application/json, text/plain, */*',

                        'X-Requested-With':
                            'Fetch',

                        'X-PJAX':
                            'true'
                    }
                }
            );

        if (!response.ok) {
            throw new Error(
                'HTTP ' +
                response.status +
                ' ' +
                response.statusText
            );
        }

        var text =
            await response.text();

        var data;

        try {
            data =
                JSON.parse(text);
        } catch (e) {
            console.error(
                '[Hydro Copy Markdown] 非 JSON PJAX 响应：',
                text.slice(0, 3000)
            );

            throw new Error(
                'PJAX 返回的不是 JSON'
            );
        }

        var content =
            findContentInPjax(data);

        if (content === null) {
            console.error(
                '[Hydro Copy Markdown] 未找到 pdoc.content：',
                data
            );

            throw new Error(
                'PJAX JSON 中没有 pdoc.content'
            );
        }

        return content;
    }

    // 比赛题页面如果存在“在题库中打开”，
    // 可以将它作为 PJAX 获取失败后的备用来源。
    function findProblemBankUrl() {
        var links =
            document.querySelectorAll(
                '.section--problem-sidebar a[href]'
            );

        for (
            var i = 0;
            i < links.length;
            i++
        ) {
            try {
                var u =
                    new URL(
                        links[i].href,
                        location.href
                    );

                if (
                    u.origin !==
                    location.origin
                ) {
                    continue;
                }

                if (
                    u.searchParams.has('tid')
                ) {
                    continue;
                }

                if (
                    /(?:^|\/)p\/[^/]+\/?$/.test(
                        u.pathname
                    )
                ) {
                    return u.href;
                }
            } catch (e) {
                // 忽略异常 URL。
            }
        }

        return null;
    }

    // 获取最终要复制的纯 Markdown。
    async function getRawMarkdown() {
        var sources = [
            location.href
        ];

        var bankUrl =
            findProblemBankUrl();

        if (
            bankUrl &&
            bankUrl !== location.href
        ) {
            sources.push(bankUrl);
        }

        var errors = [];

        for (
            var i = 0;
            i < sources.length;
            i++
        ) {
            // 不同 Hydro 部署兼容两种写法。
            var variants = [
                '1',
                'true'
            ];

            for (
                var j = 0;
                j < variants.length;
                j++
            ) {
                try {
                    var raw =
                        await requestRawContent(
                            sources[i],
                            variants[j]
                        );

                    return selectLocalizedContent(
                        raw
                    );
                } catch (e) {
                    errors.push(
                        sources[i] +
                        ' [pjax=' +
                        variants[j] +
                        ']: ' +
                        e.message
                    );
                }
            }
        }

        console.error(
            '[Hydro Copy Markdown] 所有原始题面请求均失败：',
            errors
        );

        throw new Error(
            errors.length
                ? errors[
                    errors.length - 1
                ]
                : '无法获取题目 Markdown'
        );
    }

    // 写入系统剪贴板。
    async function copyText(text) {
        if (
            typeof GM_setClipboard ===
            'function'
        ) {
            GM_setClipboard(
                text,
                'text'
            );

            return;
        }

        if (
            navigator.clipboard &&
            navigator.clipboard.writeText
        ) {
            await navigator.clipboard.writeText(
                text
            );

            return;
        }

        throw new Error(
            '当前环境没有可用的剪贴板 API'
        );
    }

    function removeInjectedButton() {
        var item =
            document.querySelector(
                '[' +
                ITEM_ATTR +
                ']'
            );

        if (
            item &&
            item.parentNode
        ) {
            item.parentNode.removeChild(
                item
            );
        }
    }

    // 创建和 Hydro 左侧菜单一致的按钮。
    function makeButton(ctx) {
        var li =
            document.createElement(
                'li'
            );

        li.className =
            'menu__item scratchpad--hide';

        li.setAttribute(
            ITEM_ATTR,
            '1'
        );

        var button =
            document.createElement(
                'a'
            );

        button.id =
            BUTTON_ID;

        button.className =
            'menu__link';

        button.href =
            '#';

        button.title =
            '复制当前语言的原始题目 Markdown';

        var icon =
            document.createElement(
                'span'
            );

        icon.className =
            'icon icon-copy';

        button.appendChild(
            icon
        );

        button.appendChild(
            document.createTextNode(' ')
        );

        var label =
            document.createElement(
                'span'
            );

        label.setAttribute(
            'data-hydro-copy-label',
            '1'
        );

        label.textContent =
            '复制 Markdown';

        button.appendChild(
            label
        );

        li.appendChild(
            button
        );

        // 插到当前锚点菜单项的正上方。
        //
        // 已登录：
        //   复制 Markdown
        //   进入在线编程模式
        //
        // 未登录：
        //   复制 Markdown
        //   登录后递交
        ctx.item.parentNode.insertBefore(
            li,
            ctx.item
        );

        button.addEventListener(
            'click',
            async function (event) {
                event.preventDefault();
                event.stopPropagation();

                if (
                    button.getAttribute(
                        'data-copying'
                    ) === '1'
                ) {
                    return;
                }

                button.setAttribute(
                    'data-copying',
                    '1'
                );

                var oldTitle =
                    button.title;

                label.textContent =
                    '正在复制…';

                try {
                    var markdown =
                        await getRawMarkdown();

                    await copyText(
                        markdown
                    );

                    label.textContent =
                        '已复制 ✓';

                    button.title =
                        '已复制 ' +
                        markdown.length +
                        ' 个字符';

                    console.log(
                        '[Hydro Copy Markdown] 复制成功：',
                        {
                            page:
                                document
                                    .documentElement
                                    .getAttribute(
                                        'data-page'
                                    ),

                            language:
                                getRenderedLanguage(),

                            anchorType:
                                ctx.anchorType,

                            tid:
                                new URL(
                                    location.href
                                ).searchParams.get(
                                    'tid'
                                ),

                            length:
                                markdown.length
                        }
                    );

                    setTimeout(
                        function () {
                            label.textContent =
                                '复制 Markdown';

                            button.title =
                                oldTitle;
                        },
                        1200
                    );
                } catch (error) {
                    console.error(
                        '[Hydro Copy Markdown] 复制失败：',
                        error
                    );

                    label.textContent =
                        '复制失败';

                    button.title =
                        '复制失败：' +
                        (
                            error &&
                            error.message
                                ? error.message
                                : String(error)
                        );

                    setTimeout(
                        function () {
                            label.textContent =
                                '复制 Markdown';

                            button.title =
                                oldTitle;
                        },
                        2500
                    );
                } finally {
                    button.removeAttribute(
                        'data-copying'
                    );
                }
            }
        );
    }

    function inject() {
        var ctx =
            getProblemContext();

        var existing =
            document.getElementById(
                BUTTON_ID
            );

        // 已不处于可识别的 Hydro 题目页时移除旧按钮。
        if (!ctx) {
            if (existing) {
                removeInjectedButton();
            }

            return false;
        }

        // Hydro 可能通过 PJAX 替换整个侧栏。
        // 如果现有按钮仍然紧挨当前锚点，就不用重建。
        if (existing) {
            var existingItem =
                existing.closest
                    ? existing.closest('li')
                    : existing.parentElement;

            if (
                existingItem &&
                existingItem.parentNode ===
                    ctx.item.parentNode &&
                existingItem.nextElementSibling ===
                    ctx.item
            ) {
                return true;
            }

            removeInjectedButton();
        }

        makeButton(ctx);

        return !!document.getElementById(
            BUTTON_ID
        );
    }

    function scheduleInject() {
        if (
            injectTimer !== null
        ) {
            clearTimeout(
                injectTimer
            );
        }

        injectTimer =
            setTimeout(
                function () {
                    injectTimer =
                        null;

                    inject();
                },
                30
            );
    }

    function start() {
        // 首次直接尝试。
        inject();

        // Hydro 自身脚本可能稍后调整 DOM，
        // 因此补几次低成本重试。
        setTimeout(
            inject,
            100
        );

        setTimeout(
            inject,
            500
        );

        setTimeout(
            inject,
            1500
        );

        // 兼容 Hydro 的 PJAX / 局部页面更新。
        var observer =
            new MutationObserver(
                scheduleInject
            );

        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: [
                    'data-app',
                    'data-page'
                ]
            }
        );

        window.addEventListener(
            'popstate',
            scheduleInject
        );

        window.addEventListener(
            'hashchange',
            scheduleInject
        );
    }

    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            start,
            {
                once: true
            }
        );
    } else {
        start();
    }
})();

/**
 * 认知记忆 (Cognitive Memory) — SillyTavern Extension
 *
 * 与 cognitive-memory Server Plugin 配合使用。
 * - 自动索引对话到认知记忆库
 * - AI 生成前自动搜索并注入记忆到 prompt
 * - 设置面板：API 配置、权重调参、衰减速率
 * - 记忆浏览器：查看/编辑/删除/标记核心
 * - 砖头机联动：推拉认知记忆块
 */

const MODULE_NAME = 'cognitive_memory';
const COG_API = '/api/plugins/zhuantouji-sync';



// ============ 默认设置 ============
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoIndex: true,
    autoInject: true,
    embEndpoint: '',
    embKey: '',
    embModel: 'text-embedding-3-small',
    scoreEndpoint: '',
    scoreKey: '',
    scoreModel: 'gpt-4o-mini',
    wRelevance: 50,
    wRecency: 30,
    wImportance: 20,
    topK: 5,
    chunkMsgs: 5,
    keepRecent: 25,
    decayRate: 1,
    customTagStart: '',
    customTagEnd: '',
    tagExtractThreshold: 300,
    injectPosition: 'after',
    injectDepth: 2,
});

// ============ 状态 ============
let pluginOnline = false;
let indexedMsgKeys = new Set();
let lastInjectedContext = '';
let surfaceTurnCounts = {};

// ============ 工具函数 ============
function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = ctx.extensionSettings[MODULE_NAME];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(s, k)) s[k] = DEFAULT_SETTINGS[k];
    }
    return s;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getCharName() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId !== undefined && ctx.characters[ctx.characterId]) {
        return ctx.characters[ctx.characterId].name || '';
    }
    return '';
}

function getChatTag() {
    const charName = getCharName();
    const ctx = SillyTavern.getContext();
    const chatId = ctx.chatId || 'default';
    return `chat:${charName}:${chatId}`;
}

async function apiCall(endpoint, options = {}) {
    const ctx = SillyTavern.getContext();
    const fetchOpts = {
        method: options.method || 'GET',
        headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
    };
    if (options.body) fetchOpts.body = JSON.stringify(options.body);
    const res = await fetch(`${COG_API}${endpoint}`, fetchOpts);
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${res.status}: ${txt.substring(0, 200)}`);
    }
    return res.json();
}

function setActionStatus(text, type = '') {
    const el = document.getElementById('cogmem_action_status');
    if (!el) return;
    el.textContent = text;
    el.className = 'cogmem-action-status ' + type;
    if (type) setTimeout(() => { el.textContent = ''; el.className = 'cogmem-action-status'; }, 4000);
}

function formatTimeAgo(ts) {
    if (!ts) return '?';
    const d = Date.now() - ts;
    const m = Math.floor(d / 60000);
    if (m < 1) return '刚才';
    if (m < 60) return `${m}分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}小时前`;
    const dd = Math.floor(h / 24);
    if (dd < 30) return `${dd}天前`;
    return `${Math.floor(dd / 30)}个月前`;
}

// ============ 分块工具 ============
function formatMsg(msg, charName, userName) {
    const sender = msg.is_user ? userName : charName;
    return `${sender}: ${(msg.mes || '').substring(0, 2000)}`;
}

/**
 * 从消息文本中提取自定义标签内的内容
 * 支持 <tag>content</tag> 和 【tag】content【/tag】 格式
 * @returns {string|null} 提取到的内容，未找到标签返回 null
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& 匹配的是整个被匹配的字符串
}

/**
 * 从消息文本中提取自定义标签内的内容
 * @returns {string|null} 提取到的内容，未找到标签返回 null
 */
function extractTagContent(messageText, startTag, endTag) {
    if (!startTag || !endTag || !messageText) return null;
    const s = startTag.trim();
    const e = endTag.trim();

    // 构建安全的正则表达式，匹配 s 和 e 之间的所有字符
    const regex = new RegExp(`${escapeRegExp(s)}([\\s\\S]*?)${escapeRegExp(e)}`, 'gi');
    const matches = [];
    let m;
    while ((m = regex.exec(messageText)) !== null) {
        matches.push(m[1].trim());
    }

    if (matches.length > 0) return matches.join('\n');
    return null;
}

function chunkMessagesByCount(messages, count, charName, userName) {
    const chunks = [];
    for (let i = 0; i < messages.length; i += count) {
        const batch = messages.slice(i, i + count);
        if (batch.length < 2) continue;
        const text = batch.map(m => formatMsg(m, charName, userName)).join('\n');
        chunks.push(text);
    }
    return chunks;
}

/**
 * 按条数分块 + 自定义标签提取
 * 如果设置了 customTag，会从每条消息中提取标签内容作为记忆文本
 * @returns {{ chunks: Array, tagExtracted: boolean }}
 */
function chunkMessagesWithTag(messages, settings, charName, userName) {
    const customTagStart = (settings.customTagStart || '').trim();
    const customTagEnd = (settings.customTagEnd || '').trim();

    // 无自定义标签，走常规按条数分块
    if (!customTagStart || !customTagEnd) {
        const chunks = chunkMessagesByCount(messages, settings.chunkMsgs || 5, charName, userName);
        return { chunks: chunks.map(text => ({ text })), tagExtracted: false };
    }

    // 有自定义标签：逐条提取标签内容
    const chunks = [];
    const batchSize = settings.chunkMsgs || 5;

    for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        const tagTexts = [];
        const fullTexts = [];

        for (const msg of batch) {
            const msgText = msg.mes || '';
            const extracted = extractTagContent(msgText, customTagStart, customTagEnd);
            if (extracted) {
                const sender = msg.is_user ? userName : charName;
                tagTexts.push(`${sender}: ${extracted}`);
            }
            fullTexts.push(formatMsg(msg, charName, userName));
        }

        if (tagTexts.length > 0) {
            // 标签提取成功：用提取内容作为记忆文本
            chunks.push({ text: tagTexts.join('\n'), isTagExtract: true });
        } else if (fullTexts.length >= 2) {
            // 未找到标签：回退到全文
            chunks.push({ text: fullTexts.join('\n'), isTagExtract: false });
        }
    }

    return { chunks, tagExtracted: chunks.some(c => c.isTagExtract) };
}

function chunkMessages(messages, settings, charName, userName) {
    return chunkMessagesByCount(messages, settings.chunkMsgs || 5, charName, userName);
}

// ============ 核心功能：自动索引 ============
async function autoIndexMessages() {
    if (!pluginOnline) return;
    const s = getSettings();
    if (!s.enabled || !s.autoIndex) return;
    const charName = getCharName();
    if (!charName) return;

    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat || chat.length < s.keepRecent + 3) return;

        const endIdx = chat.length - s.keepRecent;
        const startIdx = Math.max(0, endIdx - 30); // 最多回看30条

        // 收集未索引的非系统消息
        const newMsgs = [];
        for (let i = startIdx; i < endIdx; i++) {
            const msg = chat[i];
            if (msg.is_system) continue;
            const key = `${i}_${(msg.mes || '').substring(0, 50)}`;
            if (indexedMsgKeys.has(key)) continue;
            newMsgs.push({ msg, key });
        }

        // 判断是否积累够一块的内容
        const threshold = s.chunkMsgs || 5;
        if (newMsgs.length < threshold) return;

        const userName = ctx.name1 || 'User';
        const customTagStart = (s.customTagStart || '').trim();
        const customTagEnd = (s.customTagEnd || '').trim();

        if (customTagStart && customTagEnd) {
            // ====== 自定义标签模式 ======
            const { chunks, tagExtracted } = chunkMessagesWithTag(newMsgs.map(m => m.msg), s, charName, userName);
            if (chunks.length === 0) return;

            newMsgs.forEach(({ key }) => indexedMsgKeys.add(key));
            const tagThreshold = s.tagExtractThreshold || 300;

            // 逐块判断 autoScore 模式
            const apiChunks = chunks.map(c => ({
                text: c.text,
                timestamp: Date.now(),
                // 标签提取 + 短文本 → 只打标签不总结; 否则完整提炼
                autoScore: c.isTagExtract && c.text.length <= tagThreshold ? 'tagsOnly' : true,
            }));

            console.log(`[CogMem] 📝 Auto-indexing ${apiChunks.length} chunks (tag=${customTagStart}...${customTagEnd}, tagHits=${chunks.filter(c => c.isTagExtract).length})`);
            await apiCall('/index', { method: 'POST', body: { chatTag: getChatTag(), source: 'st', chunks: apiChunks, autoScore: 'mixed' } });
        } else {
            // ====== 常规模式 ======
            const textChunks = chunkMessages(newMsgs.map(m => m.msg), s, charName, userName);
            if (textChunks.length === 0) return;

            const chunks = textChunks.map(text => ({ text, timestamp: Date.now() }));
            newMsgs.forEach(({ key }) => indexedMsgKeys.add(key));

            console.log(`[CogMem] 📝 Auto-indexing ${chunks.length} chunks (${newMsgs.length} msgs)`);
            await apiCall('/index', { method: 'POST', body: { chatTag: getChatTag(), source: 'st', chunks, autoScore: true } });
        }

        console.log(`[CogMem] ✅ Indexed`);
        refreshStats();
    } catch (e) {
        console.warn('[CogMem] Auto-index error:', e.message);
    }
}

// ============ 核心功能：认知检索 ============
async function searchCognitiveMemory(queryText) {
    const s = getSettings();
    const result = await apiCall('/search', {
        method: 'POST',
        body: {
            chatTag: getChatTag(),
            query: queryText,
            topK: s.topK,
            weights: {
                relevance: s.wRelevance / 100,
                recency: s.wRecency / 100,
                importance: s.wImportance / 100,
            },
        },
    });
    return result;
}

function buildInjectionContext(searchResult) {
    if (!searchResult || (!searchResult.results?.length && !searchResult.graphFacts?.length)) return '';
    const s = getSettings();
    let memoryText = '';

    if (searchResult.graphFacts && searchResult.graphFacts.length > 0) {
        memoryText += `[知识图谱 - 确凿的事实关联 (非常重要)]\n${searchResult.graphFacts.join('\n')}\n---\n\n`;
    }

    for (const mem of (searchResult.results || [])) {
        const time = formatTimeAgo(mem.timestamp);
        const kwHint = mem.kwScore > 0.3 ? ' · 关键词命中' : '';
        memoryText += `[记忆 · ${time}${kwHint}]\n${mem.text}\n---\n`;
    }

    return memoryText.trim();
}

// ============ generate_interceptor ============
globalThis.cognitiveMemoryInterceptor = async function (chat, contextSize, abort, type) {
    if (!pluginOnline) return;
    const s = getSettings();
    if (!s.enabled || !s.autoInject) return;
    if (type === 'quiet') return;

    const charName = getCharName();
    if (!charName) return;

    try {
        // 用最后连续几条用户消息构建查询，并在前部增加角色名和用户名增强检索精度（Query Augmentation）
        const ctx = SillyTavern.getContext();
        const userName = ctx.name1 || 'User';
        let userMsgParts = [];

        // 从末尾向前扫描，收集连续的用户消息
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m.is_system || m.is_user === false) {
                // 遇到非用户的正常消息（AI的回复），停止收集
                if (!m.is_system && m.is_user === false) break;
                continue;
            }
            if (m.is_user) {
                const txt = (m.mes || '').trim();
                if (txt) {
                    userMsgParts.unshift(txt.substring(0, 300)); // 使用unshift保持时间顺序
                }
            }
        }

        let lastUserMsg = userMsgParts.join(' ');

        // 如果没有收到用户消息，则降级为使用倒数第一条正常消息
        if (!lastUserMsg && chat.length > 0) {
            for (let i = chat.length - 1; i >= 0; i--) {
                const m = chat[i];
                if (!m.is_system) {
                    lastUserMsg = (m.mes || '').substring(0, 300);
                    break;
                }
            }
        }

        let query = lastUserMsg.substring(0, 500);
        // Query Augmentation
        if (charName) query = `${charName} ${query}`;
        if (userName && userName !== charName) query = `${userName} ${query}`;
        query = query.substring(0, 500);

        console.log('[CogMem] 🔍 Searching cognitive memory for generation...');
        const result = await searchCognitiveMemory(query);

        // --- 记忆浮现机制 (每20轮) ---
        const chatId = ctx.chatId || 'default';
        if (!surfaceTurnCounts[chatId]) surfaceTurnCounts[chatId] = 0;
        surfaceTurnCounts[chatId]++;

        let surfaceText = '';
        if (surfaceTurnCounts[chatId] >= 20) {
            surfaceTurnCounts[chatId] = 0;
            try {
                const surfRes = await apiCall('/surface', { method: 'POST', body: { chatTag: getChatTag() } });
                if (surfRes && surfRes.surfaced) {
                    surfaceText = `\n\n[记忆浮现]\n以下是一段尘封的记忆片段，它突然浮现在你的脑海中。如果合适，你可以自然地在对话中提及或联想到这件事，如果与当前话题无关也可以忽略：\n「${surfRes.surfaced.text}」`;
                    console.log(`[CogMem] 🌊 第20轮浮现注入: "${surfRes.surfaced.text.substring(0, 40)}…"`);
                }
            } catch (e) {
                console.warn('[CogMem] Surface API failed:', e.message);
            }
        }

        if (!result.results?.length && !result.graphFacts?.length && !surfaceText) {
            console.log('[CogMem] No memory hits and no surface.');
            lastInjectedContext = '';
            updateInjectPreview();
            return;
        }

        let injectionText = buildInjectionContext(result) || '';
        injectionText += surfaceText;
        injectionText = injectionText.trim();

        lastInjectedContext = injectionText;
        console.log(`[CogMem] 🧠 Injecting ${injectionText.length} chars (pos: ${s.injectPosition})`);

        const sysMsg = {
            role: 'system',
            content: injectionText,
            mes: injectionText,
            is_user: false,
            is_system: true,
            name: 'Cognitive Memory',
            send_date: Date.now(),
            extra: { type: 'narrator', cognitive_memory: true },
        };

        // 根据注入位置插入
        if (s.injectPosition === 'before') {
            // 系统提示之前 = chat 数组最前面
            chat.splice(0, 0, sysMsg);
        } else if (s.injectPosition === 'depth') {
            // 特定深度（从末尾往前数）
            const depth = Math.min(s.injectDepth || 2, chat.length);
            const insertAt = Math.max(0, chat.length - depth);
            chat.splice(insertAt, 0, sysMsg);
        } else {
            // 默认 'after'：系统提示之后 = 第一条非系统消息之前
            let insertIdx = 0;
            for (let i = 0; i < chat.length; i++) {
                if (!chat[i].is_system && chat[i].role !== 'system') {
                    insertIdx = i;
                    break;
                }
                insertIdx = i + 1;
            }
            chat.splice(insertIdx, 0, sysMsg);
        }

        // 刷新渲染
        updateInjectPreview();
    } catch (e) {
        console.warn('[CogMem] Interceptor error:', e.message);
    }
};

// ============ 操作：全量索引 ============
async function fullIndexCurrentChat() {
    const charName = getCharName();
    if (!charName) {
        toastr.warning('请先打开一个角色聊天');
        return;
    }

    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!chat || chat.length < 2) {
        toastr.warning('当前聊天消息太少');
        return;
    }

    setActionStatus('正在全量索引...');
    const s = getSettings();
    const userName = ctx.name1 || 'User';

    try {
        const filtered = chat.filter(m => !m.is_system);
        const textChunks = chunkMessages(filtered, s, charName, userName);
        const chunks = textChunks.map((text, i) => ({
            text,
            timestamp: Date.now() - (textChunks.length - i) * 300000,
        }));

        if (chunks.length === 0) {
            setActionStatus('没有有效内容', 'error');
            return;
        }

        // 分批发送
        let done = 0;
        const batchSize = 10;
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            await apiCall('/index', { method: 'POST', body: { chatTag: getChatTag(), source: 'st', chunks: batch, autoScore: true, userName: ctx.name1 || 'User', charName } });
            done += batch.length;
            setActionStatus(`索引中... ${done}/${chunks.length}`);
        }

        const totalChars = filtered.reduce((s, m) => s + (m.mes || '').length, 0);
        setActionStatus(`✅ 完成！${filtered.length} 条消息 (${totalChars} 字) → ${chunks.length} 个记忆块`, 'success');
        refreshStats();
    } catch (e) {
        setActionStatus(`❌ ${e.message}`, 'error');
    }
}

// ============ 操作：记忆浏览器 ============
async function openMemoryBrowser() {
    const charName = getCharName();
    if (!charName) {
        toastr.warning('请先打开一个角色聊天');
        return;
    }

    try {
        const data = await apiCall(`/memories?chatTag=${encodeURIComponent(getChatTag())}&sort=importance&limit=50`);
        if (!data.memories || data.memories.length === 0) {
            toastr.info(`${charName} 暂无认知记忆，请先全量索引。`);
            return;
        }

        let html = '<div class="cogmem-browser">';
        html += `<div class="cogmem-browser-header">`;
        html += `<span>共 ${data.stats.total} 条 · ${data.stats.core || 0} 核心 · ${data.stats.archived || 0} 归档</span>`;
        html += '</div>';

        for (const mem of data.memories) {
            const impClass = mem.importance >= 7 ? 'imp-high' : mem.importance >= 4 ? 'imp-mid' : 'imp-low';
            const impBar = '■'.repeat(Math.min(10, mem.importance)) + '□'.repeat(Math.max(0, 10 - mem.importance));
            const coreTag = mem.isCore ? '<span class="cogmem-mem-core-tag">[核心]</span>' : '';
            const timeStr = new Date(mem.createdAt).toLocaleString();

            html += `<div class="cogmem-mem-card ${impClass}" data-memid="${mem.id}">`;
            html += `<div class="cogmem-mem-title">`;
            html += `<span>${mem.summary || (mem.text || '').substring(0, 40) + '…'} ${coreTag}</span>`;
            html += `<span class="cogmem-mem-time">${timeStr}</span>`;
            html += `</div>`;
            html += `<div class="cogmem-mem-meta">重要性 ${impBar} ${mem.importance}/10 · 回忆 ${mem.accessCount || 0} 次</div>`;

            if (mem.keywords && mem.keywords.length > 0) {
                html += `<div class="cogmem-mem-keywords">${mem.keywords.map(k => `<span class="cogmem-mem-kw-tag">${k}</span>`).join('')}</div>`;
            }

            html += `<div class="cogmem-mem-text">${(mem.text || '').substring(0, 200)}${(mem.text || '').length > 200 ? '…' : ''}</div>`;
            html += `<div class="cogmem-mem-actions">`;
            html += `<button onclick="cogMemToggleCore('${mem.id}', ${!mem.isCore})">${mem.isCore ? '取消核心' : '📌 标记核心'}</button>`;
            html += `<button onclick="cogMemArchive('${mem.id}')">📦 归档</button>`;
            html += `<button class="danger" onclick="cogMemDelete('${mem.id}')">🗑 删除</button>`;
            html += `</div></div>`;
        }
        html += '</div>';

        const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
        await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, okButton: '关闭' });
    } catch (e) {
        toastr.error(`记忆浏览失败: ${e.message}`);
    }
}

// 记忆操作（全局函数供 onclick 调用）
globalThis.cogMemToggleCore = async function (id, isCore) {
    try {
        await apiCall(`/memories/${encodeURIComponent(id)}`, { method: 'PUT', body: { isCore } });
        toastr.success(isCore ? '已标记为核心记忆' : '已取消核心标记');
    } catch (e) { toastr.error(e.message); }
};
globalThis.cogMemArchive = async function (id) {
    try {
        await apiCall(`/memories/${encodeURIComponent(id)}`, { method: 'PUT', body: { isArchived: true } });
        toastr.success('已归档');
        const card = document.querySelector(`.cogmem-mem-card[data-memid="${id}"]`);
        if (card) card.style.opacity = '0.3';
    } catch (e) { toastr.error(e.message); }
};
globalThis.cogMemDelete = async function (id) {
    if (!confirm('确定删除这条记忆？')) return;
    try {
        await apiCall(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const card = document.querySelector(`.cogmem-mem-card[data-memid="${id}"]`);
        if (card) card.remove();
        toastr.success('已删除');
    } catch (e) { toastr.error(e.message); }
};

// ============ 操作：砖头机同步 ============
async function doSyncPush(asVector) {
    const charName = getCharName();
    if (!charName) { setActionStatus('请先打开角色聊天', 'error'); return; }

    const userName = SillyTavern.getContext().name1 || 'User';
    const characterName = SillyTavern.getContext().name2 || charName;

    // 1. 获取聊天消息并找到上次节点
    let messages = [];
    if (typeof getChatMessages === 'function') {
        const lastId = typeof getLastMessageId === 'function' ? getLastMessageId() : 0;
        messages = getChatMessages(`0-${lastId}`);
    }
    if (!messages || messages.length === 0) { setActionStatus('当前聊天没有消息', 'error'); return; }

    let startIndex = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msgText = messages[i].message || '';
        if (msgText.includes('正式切换为线下见面/现实互动模式') || msgText.includes('已同步到砖头机：线下记忆摘要')) {
            startIndex = i + 1;
            break;
        }
    }
    messages = messages.slice(startIndex);
    if (messages.length === 0) { setActionStatus('上次同步后暂无新内容', ''); return; }

    let chatText = '';
    messages.forEach(msg => {
        const sender = msg.is_user ? userName : characterName;
        const content = (msg.message || '').substring(0, 800);
        chatText += `${sender}: ${content}\n`;
    });
    if (chatText.length > 25000) chatText = '...(前面的内容已省略)\n' + chatText.slice(-25000);

    const summaryPrompt = `你是一个情感细腻的故事记录者。请仔细阅读以下两人之间的对话记录，并为他们提取一份充满人情味、画面感和情感张力的“记忆档案”。

【重要写作红线 - 绝对禁止】
1. 拒绝机械化报告Tone：严禁使用“在这段对话中”、“展现了”、“说明了”、“用户与角色”、“产生互动”等冰冷的、上帝视角的分析式套话。
2. 拒绝“AI味”专有名词：严禁出现“羁绊”、“情感共鸣”、“灵魂交织”、“宿命感”、“情感升温”、“拉扯”等泛滥且油腻的AI总结词汇。
3. 称呼自然：直接使用名字“${userName}”和“${characterName}”，绝对不要使用“用户”、“玩家”、“角色”、“AI”等出戏称呼。

【写作指引】
沉浸式回忆：请用像写小说设定集。细腻地捕捉两人之间的情绪流动、空气中的温度，以及那些没有明说的心思。让文字能够真实触动人心。

对话内容：
${chatText}

请按照以下格式输出你的档案：

【剧情总结】
(抛弃干瘪的流水账，用细腻柔和、充满情感温度的语言，回顾两人这段时间共同经历的故事脉络。重点描绘他们之间发生的特殊事件、关键抉择以及两人内心情绪。1000字左右。)

【当前关系状态】
(请用一两句话精准概括当下微妙的心理距离。例如：${userName} & ${characterName}：正处于患得患失的暧昧期，彼此试探却又忍不住向对方靠近。)

【关键记忆碎片】
(按时间顺序，像幻灯片一样，列举出几幕推动两人关系发展的具体事件画面。写出当时的情境氛围和彼此的心情。)

【时间跨度】
(记录这段经历的具体或大致时间跨度。)

【言外之意与暗线】
(记录那些欲言又止的细节、未解开的心结、伏笔。)

【情感信物】
(如果有提及，描述具有特殊情感意义的物品、互送的礼物或某个承载回忆的地点，并说明它对两人意味着什么。若无则简要注明即可。)

只输出以上六个板块的内容，千万不要添加开头和结尾的额外寒暄说明文字。`;

    try {
        setActionStatus('正在生成总结，请稍候...', 'info');
        const summary = await window.generateRaw({
            user_input: summaryPrompt,
            should_silence: true,
            max_chat_history: 0,
            max_tokens: 4096,
            ordered_prompts: ['user_input']
        });

        if (!summary || !summary.trim()) throw new Error('摘要生成失败：返回为空');
        
        if (asVector) {
            const memoryEntry = {
                id: 'card_st_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                text: summary.trim(),
                source: 'st',
                timestamp: Date.now(),
                isCore: true
            };
            // 2. 推送到认知记忆后端
            await apiCall('/sync/push', {
                method: 'POST',
                body: { chatTag: `chat:${getCharName()}`, source: 'st', memories: [memoryEntry] }
            });
            
            // 3. 插入本地聊天流
            const summaryMessage = `<details>\n<summary>📱 <b>已同步到砖头机：线下卡片 (触发打标)</b></summary>\n\n${summary.trim()}\n\n</details>\n\n*(系统提示：以上线下互动记忆已同步至砖头机并打标为核心向量，线上聊天时角色会自然地体现对这些经历的了解。)*`;
            if (typeof createChatMessages === 'function') {
                await createChatMessages([{ role: 'system', message: summaryMessage }]);
            }
            setActionStatus(`✅ 成功生成剧情总结并推送为向量卡片！`, 'success');
        } else {
            // 推送到传统的 zhuantouji-sync 后端
            const memoryEntry = {
                t: `线下 AIRP 记忆 (${new Date().toLocaleString()})`,
                c: summary.trim(),
                ts: new Date().toISOString(),
            };
            const fetchOptions = {
                method: 'POST',
                headers: { ...SillyTavern.getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ char: getCharName(), source: 'st', memories: [memoryEntry] })
            };
            const res = await fetch('/api/plugins/zhuantouji-sync/push', fetchOptions);
            if (!res.ok) throw new Error(`Traditional API Error ${res.status}`);
            
            // 3. 插入本地聊天流
            const summaryMessage = `<details>\n<summary>📱 <b>已同步到砖头机：线下记忆摘要 (纯总结)</b></summary>\n\n${summary.trim()}\n\n</details>\n\n*(系统提示：以上线下互动记忆已同步至砖头机的记忆列表，线上聊天时角色会自然地体现对这些经历的了解。)*`;
            if (typeof createChatMessages === 'function') {
                await createChatMessages([{ role: 'system', message: summaryMessage }]);
            }
            setActionStatus(`✅ 成功生成剧情总结并推送到记忆列表！`, 'success');
        }
    } catch (e) {
        setActionStatus(`❌ ${e.message}`, 'error');
    }
}

async function syncPullTrad() {
    const charName = getCharName();
    if (!charName) { setActionStatus('请先打开角色聊天', 'error'); return; }
    try {
        const fetchOptions = { headers: SillyTavern.getRequestHeaders() };
        const res = await fetch(`/api/plugins/zhuantouji-sync/pull?char=${encodeURIComponent(charName)}&source=ztj`, fetchOptions);
        if (res.ok) {
            const result = await res.json();
            if (result.memories && result.memories.length > 0) {
                let injectContent = '<details>\n<summary>📱 <b>点击展开：从砖头机同步的线上聊天前情</b></summary>\n\n';
                result.memories.forEach((mem, i) => {
                    injectContent += `[线上记忆${i + 1}: ${mem.t || '日常聊天'}]\n${mem.c || ''}\n\n`;
                });
                injectContent += '</details>\n\n*(系统提示：双方已结束线上交流，正式切换为线下见面/现实互动模式。请结合上方的前情摘要，自然流畅地展开接下来的剧情。)*';
                
                if (typeof createChatMessages === 'function') {
                    await createChatMessages([{ role: 'system', message: injectContent }]);
                }
                setActionStatus(`✅ 成功拉取砖头机总结并插入背景！`, 'success');
            } else {
                setActionStatus('暂无来自砖头机的新聊天总结', '');
            }
        }
    } catch (e) { setActionStatus(`❌ 传统拉取失败: ${e.message}`, 'error'); }
}

async function syncPullVec() {
    const charName = getCharName();
    if (!charName) { setActionStatus('请先打开角色聊天', 'error'); return; }
    try {
        const syncChatTag = `chat:${charName}`;
        const data = await apiCall(`/memories?chatTag=${encodeURIComponent(syncChatTag)}&limit=1000`);
        const cards = (data?.memories || []).filter(m => m.id && m.id.startsWith('card_ztj_') && !m.isArchived);

        if (cards.length > 0) {
            let injectContent = '<details>\n<summary>📱 <b>点击展开：从砖头机同步的前情提要（近3条日记）</b></summary>\n\n';
            for (const mem of cards) {
                await apiCall(`/memories/${encodeURIComponent(mem.id)}`, { method: 'PUT', body: { isArchived: true } });
            }
            const displayCards = cards
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, 3)
                .reverse();

            for (const [i, mem] of displayCards.entries()) {
                injectContent += `[事件日记 ${i + 1}]\n${mem.text || ''}\n\n`;
            }
            injectContent += '</details>\n\n*(系统提示：以上是近三天砖头机线下的事件日记背景，请结合这些线索，自然流畅地展开接下来的剧情。)*';

            if (typeof createChatMessages === 'function') {
                await createChatMessages([{ role: 'system', message: injectContent }]);
            }
            setActionStatus(`✅ 成功拉取砖头机日记卡片并插入背景！`, 'success');
        } else {
            setActionStatus('暂无来自砖头机的未读日记卡片', '');
        }
    } catch (e) { setActionStatus(`❌ 向量拉取失败: ${e.message}`, 'error'); }
}


// ============ 调试检测 ============
function setDiagStatus(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'cogmem-diag-status ' + cls;
}

function diagLog(text) {
    const el = document.getElementById('cogmem_diag_detail');
    if (!el) return;
    el.classList.add('visible');
    el.textContent += text + '\n';
    el.scrollTop = el.scrollHeight;
}

function diagClear() {
    const el = document.getElementById('cogmem_diag_detail');
    if (el) { el.textContent = ''; el.classList.remove('visible'); }
}

async function diagTestPlugin() {
    setDiagStatus('cogmem_diag_plugin_status', '检测中…', 'testing');
    diagLog('── 服务端插件 ──');
    try {
        const data = await apiCall('/diag', { method: 'POST', body: { chatTag: getChatTag(), test: 'plugin' } });
        if (data.plugin?.ok) {
            setDiagStatus('cogmem_diag_plugin_status', `✓ ${data.plugin.totalMemories} 条`, 'pass');
            diagLog(`  ✓ 插件在线, 总记忆 ${data.plugin.totalMemories} 条`);
            diagLog(`  📂 ${data.plugin.dbPath}`);
        } else {
            setDiagStatus('cogmem_diag_plugin_status', '✗ 错误', 'fail');
            diagLog(`  ✗ ${data.plugin?.error || '未知错误'}`);
        }
    } catch (e) {
        setDiagStatus('cogmem_diag_plugin_status', '✗ 离线', 'fail');
        diagLog(`  ✗ 无法连接: ${e.message}`);
    }
}

async function diagTestEmbedding() {
    setDiagStatus('cogmem_diag_emb_status', '检测中…', 'testing');
    diagLog('── Embedding API ──');
    try {
        const data = await apiCall('/diag', { method: 'POST', body: { chatTag: getChatTag(), test: 'embedding' } });
        if (data.embedding?.ok) {
            setDiagStatus('cogmem_diag_emb_status', `✓ ${data.embedding.latencyMs}ms`, 'pass');
            diagLog(`  ✓ 模型: ${data.embedding.model}`);
            diagLog(`  ✓ 维度: ${data.embedding.dimensions}`);
            diagLog(`  ✓ 延迟: ${data.embedding.latencyMs}ms`);
        } else if (!data.embedding?.configured) {
            setDiagStatus('cogmem_diag_emb_status', '⚠ 未配置', 'warn');
            diagLog('  ⚠ 未配置 Embedding API (请先填写并保存到服务端)');
        } else {
            setDiagStatus('cogmem_diag_emb_status', '✗ 失败', 'fail');
            diagLog(`  ✗ ${data.embedding?.error || '请求失败'}`);
        }
    } catch (e) {
        setDiagStatus('cogmem_diag_emb_status', '✗ 错误', 'fail');
        diagLog(`  ✗ ${e.message}`);
    }
}

async function diagTestScoring() {
    setDiagStatus('cogmem_diag_llm_status', '检测中…', 'testing');
    diagLog('── 评估 LLM ──');
    try {
        const data = await apiCall('/diag', { method: 'POST', body: { chatTag: getChatTag(), test: 'scoring' } });
        if (data.scoring?.ok) {
            const r = data.scoring.result;
            setDiagStatus('cogmem_diag_llm_status', `✓ ${data.scoring.latencyMs}ms`, 'pass');
            diagLog(`  ✓ 模型: ${data.scoring.model}`);
            diagLog(`  ✓ 延迟: ${data.scoring.latencyMs}ms`);
            diagLog(`  ✓ 测试评分: 重要性=${r.importance}/10, 情绪=${r.emotionType}(${r.emotionScore})`);
            diagLog(`  ✓ 摘要: ${r.summary}`);
            diagLog(`  ✓ 关键词: [${r.keywords?.join(', ') || '无'}]`);
        } else if (!data.scoring?.configured) {
            setDiagStatus('cogmem_diag_llm_status', '⚠ 未配置', 'warn');
            diagLog('  ⚠ 评估 LLM 未配置 (将使用默认评分)');
        } else {
            setDiagStatus('cogmem_diag_llm_status', '✗ 失败', 'fail');
            diagLog(`  ✗ ${data.scoring?.error || '请求失败'}`);
        }
    } catch (e) {
        setDiagStatus('cogmem_diag_llm_status', '✗ 错误', 'fail');
        diagLog(`  ✗ ${e.message}`);
    }
}

async function diagTestDB() {
    setDiagStatus('cogmem_diag_db_status', '检测中…', 'testing');
    diagLog('── 记忆数据库 ──');
    try {
        const data = await apiCall('/diag', { method: 'POST', body: { chatTag: getChatTag(), test: 'db' } });
        if (data.db?.ok) {
            if (data.db.chatTag) {
                setDiagStatus('cogmem_diag_db_status', `✓ ${data.db.total} 条`, 'pass');
                diagLog(`  ✓ 角色: ${data.db.chatTag}`);
                diagLog(`  ✓ 总计: ${data.db.total} | 核心: ${data.db.core || 0} | 归档: ${data.db.archived || 0}`);
                diagLog(`  ✓ 平均重要性: ${data.db.avgImp ?? 'N/A'}`);
            } else {
                setDiagStatus('cogmem_diag_db_status', `✓ ${data.db.totalAll}`, 'pass');
                diagLog(`  ✓ 全局: ${data.db.totalAll} 条 (${data.db.note})`);
            }
        } else {
            setDiagStatus('cogmem_diag_db_status', '✗ 错误', 'fail');
            diagLog(`  ✗ ${data.db?.error || '查询失败'}`);
        }
    } catch (e) {
        setDiagStatus('cogmem_diag_db_status', '✗ 错误', 'fail');
        diagLog(`  ✗ ${e.message}`);
    }
}

async function runFullDiag() {
    diagClear();
    diagLog(`🔍 认知记忆诊断 — ${new Date().toLocaleString()}`);
    diagLog(`角色: ${getCharName() || '(未选择)'}\n`);
    await diagTestPlugin();
    await diagTestEmbedding();
    await diagTestScoring();
    await diagTestDB();
    diagLog('\n✅ 诊断完成');
}

function updateInjectPreview() {
    const el = document.getElementById('cogmem_last_inject');
    if (!el) return;
    if (lastInjectedContext) {
        el.textContent = lastInjectedContext.substring(0, 2000);
        if (lastInjectedContext.length > 2000) el.textContent += '\n… (截断)';
    } else {
        el.textContent = '尚未注入';
    }
}

// ============ 诊断搜索 ============
async function diagSearch() {
    const q = document.getElementById('cogmem_diag_query')?.value?.trim();
    if (!q) return;
    const el = document.getElementById('cogmem_diag_results');
    if (!el) return;
    el.textContent = '搜索中...';

    try {
        const result = await searchCognitiveMemory(q);
        if (!result.results || result.results.length === 0) {
            el.textContent = `无结果（候选池: ${result.total || 0}）`;
            return;
        }
        let html = `<div style="margin-bottom:4px;opacity:0.6">候选 ${result.total} → 命中 ${result.results.length}</div>`;
        for (const r of result.results) {
            html += `<div style="margin-bottom:6px;padding:4px;background:var(--SmartThemeBlurTintColor);border-radius:4px;">`;
            html += `<b>${r.summary || r.text.substring(0, 40)}</b> `;
            html += `<span style="opacity:0.5">[score=${r.score.toFixed(3)} rel=${r.relevance} kw=${r.kwScore || 0} rec=${r.recency} imp=${r.importance}]</span>`;
            html += `<div style="font-size:11px;opacity:0.6;margin-top:2px;">${r.text.substring(0, 120)}</div>`;
            html += `</div>`;
        }
        el.innerHTML = html;
    } catch (e) {
        el.textContent = `❌ ${e.message}`;
    }
}

// ============ 刷新统计 ============
async function refreshStats() {
    const charName = getCharName();
    if (!charName || !pluginOnline) {
        document.getElementById('cogmem_stat_total')?.replaceChildren(document.createTextNode('记忆: --'));
        document.getElementById('cogmem_stat_core')?.replaceChildren(document.createTextNode('核心: --'));
        document.getElementById('cogmem_stat_archived')?.replaceChildren(document.createTextNode('归档: --'));
        return;
    }
    try {
        const data = await apiCall(`/memories?chatTag=${encodeURIComponent(getChatTag())}&sort=created&limit=1`);
        const st = data?.stats || {};
        document.getElementById('cogmem_stat_total')?.replaceChildren(document.createTextNode(`记忆: ${st.total || 0}`));
        document.getElementById('cogmem_stat_core')?.replaceChildren(document.createTextNode(`核心: ${st.core || 0}`));
        document.getElementById('cogmem_stat_archived')?.replaceChildren(document.createTextNode(`归档: ${st.archived || 0}`));
    } catch { /* ignore */ }
}

// ============ UI ↔ Settings 双向绑定 ============
function populateUI() {
    // 界面已极简为“剧情驿站”卡片化同步，不再需要复杂的参数配置。
}

function bindEvents() {
    // 按钮
    document.getElementById('cogmem_btn_push_trad')?.addEventListener('click', () => doSyncPush(false));
    document.getElementById('cogmem_btn_pull_trad')?.addEventListener('click', syncPullTrad);
    document.getElementById('cogmem_btn_push_vec')?.addEventListener('click', () => doSyncPush(true));
    document.getElementById('cogmem_btn_pull_vec')?.addEventListener('click', syncPullVec);
}

// ============ 初始化 ============
(async function init() {
    try {
        const ctx = SillyTavern.getContext();
        console.log('[CogMem] 🚀 前端扩展初始化开始...');

        // 检测插件
        try {
            const status = await apiCall('/status');
            pluginOnline = !!(status && (status.plugin === 'cognitive-memory' || status.status === 'ok'));
            console.log('[CogMem] 插件状态:', pluginOnline ? '在线' : '离线');
        } catch (e) {
            pluginOnline = false;
            console.warn('[CogMem] ⚠️ 无法连接服务端插件:', e.message);
        }

        // 渲染设置面板
        const { renderExtensionTemplateAsync } = ctx;
        const settingsHtml = await renderExtensionTemplateAsync('third-party/cognitive-memory-ext', 'settings');
        $('#extensions_settings2').append(settingsHtml);
        console.log('[CogMem] ✅ 设置面板已渲染');

        // 填充 UI
        try { populateUI(); console.log('[CogMem] ✅ populateUI 完成'); }
        catch (e) { console.error('[CogMem] ❌ populateUI 崩溃:', e); }

        // 绑定事件（独立 try-catch，确保即使 populateUI 崩溃也能绑定按钮）
        try { bindEvents(); console.log('[CogMem] ✅ bindEvents 完成'); }
        catch (e) { console.error('[CogMem] ❌ bindEvents 崩溃:', e); }

        // 更新状态徽章
        const badge = document.getElementById('cogmem_status_badge');
        if (badge) {
            if (pluginOnline) {
                badge.textContent = '已连接';
                badge.style.background = '#28a745';
            } else {
                badge.textContent = '未连接';
                badge.style.background = '#dc3545';
            }
        }

        // 事件钩子
        const { eventSource, event_types } = ctx;

        // 聊天切换
        eventSource.on(event_types.CHAT_CHANGED, () => {
            indexedMsgKeys.clear();
            lastInjectedContext = '';
            refreshStats();
            updateInjectPreview();
        });

        // 自动索引（收到消息后延迟）
        let indexTimer = null;
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            if (indexTimer) clearTimeout(indexTimer);
            indexTimer = setTimeout(() => { autoIndexMessages(); indexTimer = null; }, 3000);
        });

        // 初始统计
        refreshStats();

        console.log(`[CogMem] 🧠 认知记忆扩展已加载 (plugin: ${pluginOnline ? '在线' : '离线'})`);
    } catch (fatalErr) {
        console.error('[CogMem] ❌❌❌ 扩展初始化失败:', fatalErr);
    }
})();

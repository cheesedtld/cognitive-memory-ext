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
const COG_API = '/api/plugins/cognitive-memory';

const VIVIDNESS_LABELS = { deep: '深刻', clear: '清晰', fading: '褪色', vague: '模糊' };
const EMOTION_EMOJI = { joy: '😊', love: '💕', sadness: '😢', anger: '😠', fear: '😰', surprise: '😲', neutral: '' };

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
    chunkMode: 'chars',
    chunkChars: 1000,
    chunkMsgs: 5,
    keepRecent: 10,
    decayRate: 1,
    injectTemplate: '[角色记忆 — 认知检索]\n以下是你自然想起的过往经历，按印象深浅排列。这些是已经发生过的事，请视为你自己的记忆：\n\n{{text}}',
    injectPosition: 'after',
    injectDepth: 2,
});

// ============ 状态 ============
let pluginOnline = false;
let indexedMsgKeys = new Set();
let lastInjectedContext = '';

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
    return `chat:${getCharName()}`;
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

function chunkMessagesByChars(messages, maxChars, charName, userName) {
    const chunks = [];
    let currentLines = [];
    let currentLen = 0;

    for (const msg of messages) {
        const line = formatMsg(msg, charName, userName);
        if (currentLen + line.length > maxChars && currentLines.length > 0) {
            chunks.push(currentLines.join('\n'));
            currentLines = [];
            currentLen = 0;
        }
        currentLines.push(line);
        currentLen += line.length;
    }
    if (currentLines.length >= 2) chunks.push(currentLines.join('\n'));
    return chunks;
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

function chunkMessages(messages, settings, charName, userName) {
    if (settings.chunkMode === 'messages') {
        return chunkMessagesByCount(messages, settings.chunkMsgs || 5, charName, userName);
    }
    return chunkMessagesByChars(messages, settings.chunkChars || 1000, charName, userName);
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
        const totalChars = newMsgs.reduce((sum, { msg }) => sum + (msg.mes || '').length, 0);
        const threshold = s.chunkMode === 'messages' ? (s.chunkMsgs || 5) : (s.chunkChars || 1000);
        if (s.chunkMode === 'messages' ? newMsgs.length < threshold : totalChars < threshold) return;

        const userName = ctx.name1 || 'User';
        const textChunks = chunkMessages(newMsgs.map(m => m.msg), s, charName, userName);

        if (textChunks.length === 0) return;

        const chunks = textChunks.map(text => ({ text, timestamp: Date.now() }));
        newMsgs.forEach(({ key }) => indexedMsgKeys.add(key));

        console.log(`[CogMem] 📝 Auto-indexing ${chunks.length} chunks (${newMsgs.length} msgs, ${totalChars} chars, mode: ${s.chunkMode})`);
        await apiCall('/index', { method: 'POST', body: { chatTag: getChatTag(), source: 'st', chunks, autoScore: true } });
        console.log(`[CogMem] ✅ Indexed ${chunks.length} chunks`);
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

function buildInjectionContext(results) {
    if (!results || results.length === 0) return '';
    const s = getSettings();
    let memoryText = '';

    for (const mem of results) {
        const time = formatTimeAgo(mem.timestamp);
        const emoji = EMOTION_EMOJI[mem.emotionType] || '';
        const label = VIVIDNESS_LABELS[mem.vividness] || '记忆';

        if (mem.vividness === 'deep' || mem.vividness === 'clear') {
            memoryText += `[${label} · ${time}${emoji ? ' ' + emoji : ''}]\n${mem.text}\n---\n`;
        } else if (mem.vividness === 'fading') {
            memoryText += `[${label} · ${time}] ${mem.summary || mem.text.substring(0, 100)}\n---\n`;
        } else {
            memoryText += `[${label}] ${mem.summary || mem.text.substring(0, 50)}\n`;
        }
    }

    // 应用注入模板
    const template = s.injectTemplate || '{{text}}';
    return template.replace('{{text}}', memoryText.trim());
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
        // 用最后几条消息构建查询
        const recentMsgs = chat.slice(-3);
        const ctx = SillyTavern.getContext();
        const userName = ctx.name1 || 'User';
        const query = recentMsgs.map(m => {
            const sender = m.is_user ? userName : charName;
            return `${sender}: ${(m.mes || '').substring(0, 300)}`;
        }).join('\n');

        console.log('[CogMem] 🔍 Searching cognitive memory for generation...');
        const result = await searchCognitiveMemory(query);

        if (!result.results || result.results.length === 0) {
            console.log('[CogMem] No memory hits.');
            lastInjectedContext = '';
            updateInjectPreview();
            return;
        }

        const injectionText = buildInjectionContext(result.results);
        lastInjectedContext = injectionText;
        console.log(`[CogMem] 🧠 Found ${result.results.length} memories, injecting ${injectionText.length} chars (pos: ${s.injectPosition})`);

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
            await apiCall('/index', { method: 'POST', body: { chatTag: getChatTag(), source: 'st', chunks: batch, autoScore: true } });
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
            const emoji = EMOTION_EMOJI[mem.emotionType] || '';
            const impClass = mem.importance >= 7 ? 'imp-high' : mem.importance >= 4 ? 'imp-mid' : 'imp-low';
            const impBar = '■'.repeat(Math.min(10, mem.importance)) + '□'.repeat(Math.max(0, 10 - mem.importance));
            const coreTag = mem.isCore ? '<span class="cogmem-mem-core-tag">[核心]</span>' : '';
            const timeStr = new Date(mem.createdAt).toLocaleString();

            html += `<div class="cogmem-mem-card ${impClass}" data-memid="${mem.id}">`;
            html += `<div class="cogmem-mem-title">`;
            html += `<span>${emoji} ${mem.summary || (mem.text || '').substring(0, 40) + '…'} ${coreTag}</span>`;
            html += `<span class="cogmem-mem-time">${timeStr}</span>`;
            html += `</div>`;
            html += `<div class="cogmem-mem-meta">重要性 ${impBar} ${mem.importance}/10 · ${mem.emotionType} · 提起 ${mem.accessCount} 次</div>`;

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
async function syncPush() {
    const charName = getCharName();
    if (!charName) { toastr.warning('请先打开角色聊天'); return; }
    try {
        const data = await apiCall(`/memories?chatTag=${encodeURIComponent(getChatTag())}&sort=created&limit=200`);
        const count = data?.memories?.length || 0;
        setActionStatus(`认知记忆库有 ${count} 条，砖头机可通过「从酒馆拉取」获取`, 'success');
    } catch (e) { setActionStatus(`❌ ${e.message}`, 'error'); }
}

async function syncPull() {
    const charName = getCharName();
    if (!charName) { toastr.warning('请先打开角色聊天'); return; }
    try {
        const data = await apiCall(`/sync/pull?chatTag=${encodeURIComponent(getChatTag())}&source=ztj`);
        const count = data?.memories?.length || 0;
        if (count === 0) {
            setActionStatus('砖头机暂无新记忆', '');
        } else {
            setActionStatus(`✅ 已拉取 ${count} 块来自砖头机的记忆`, 'success');
        }
        refreshStats();
    } catch (e) { setActionStatus(`❌ ${e.message}`, 'error'); }
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
            const emoji = EMOTION_EMOJI[r.emotionType] || '';
            html += `<div style="margin-bottom:6px;padding:4px;background:var(--SmartThemeBlurTintColor);border-radius:4px;">`;
            html += `<b>${emoji} ${r.summary || r.text.substring(0, 40)}</b> `;
            html += `<span style="opacity:0.5">[score=${r.score.toFixed(3)} rel=${r.relevance} rec=${r.recency} imp=${r.importance} ${r.vividness}]</span>`;
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
    const s = getSettings();
    const el = id => document.getElementById(id);

    el('cogmem_enabled').checked = s.enabled;
    el('cogmem_auto_index').checked = s.autoIndex;
    el('cogmem_auto_inject').checked = s.autoInject;
    el('cogmem_emb_endpoint').value = s.embEndpoint;
    el('cogmem_emb_key').value = s.embKey;
    el('cogmem_emb_model').value = s.embModel;
    el('cogmem_score_endpoint').value = s.scoreEndpoint;
    el('cogmem_score_key').value = s.scoreKey;
    el('cogmem_score_model').value = s.scoreModel;
    el('cogmem_topk').value = s.topK;
    el('cogmem_chunk_chars').value = s.chunkChars;
    el('cogmem_chunk_msgs').value = s.chunkMsgs;
    el('cogmem_keep_recent').value = s.keepRecent;
    // 分块模式单选
    const chunkRadios = document.querySelectorAll('input[name="cogmem_chunk_mode"]');
    chunkRadios.forEach(r => { r.checked = r.value === s.chunkMode; });

    el('cogmem_w_relevance').value = s.wRelevance;
    el('cogmem_w_recency').value = s.wRecency;
    el('cogmem_w_importance').value = s.wImportance;
    el('cogmem_decay_rate').value = s.decayRate;

    el('cogmem_inject_template').value = s.injectTemplate;
    el('cogmem_inject_depth').value = s.injectDepth;
    // 设置单选按钮
    const radios = document.querySelectorAll('input[name="cogmem_inject_pos"]');
    radios.forEach(r => { r.checked = r.value === s.injectPosition; });
}

function bindEvents() {
    const s = getSettings();
    const bindVal = (id, key, transform = v => v) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => { s[key] = transform(el.type === 'checkbox' ? el.checked : el.value); saveSettings(); });
        if (el.type === 'text' || el.type === 'password' || el.type === 'number') {
            el.addEventListener('input', () => { s[key] = transform(el.value); saveSettings(); });
        }
    };

    bindVal('cogmem_enabled', 'enabled');
    bindVal('cogmem_auto_index', 'autoIndex');
    bindVal('cogmem_auto_inject', 'autoInject');
    bindVal('cogmem_emb_endpoint', 'embEndpoint', v => v.trim());
    bindVal('cogmem_emb_key', 'embKey', v => v.trim());
    bindVal('cogmem_emb_model', 'embModel', v => v.trim());
    bindVal('cogmem_score_endpoint', 'scoreEndpoint', v => v.trim());
    bindVal('cogmem_score_key', 'scoreKey', v => v.trim());
    bindVal('cogmem_score_model', 'scoreModel', v => v.trim());
    bindVal('cogmem_topk', 'topK', v => parseInt(v) || 5);
    bindVal('cogmem_chunk_chars', 'chunkChars', v => Math.max(200, parseInt(v) || 1000));
    bindVal('cogmem_chunk_msgs', 'chunkMsgs', v => Math.max(1, parseInt(v) || 5));
    bindVal('cogmem_keep_recent', 'keepRecent', v => parseInt(v) || 10);

    // 分块模式
    const chunkModeRadios = document.querySelectorAll('input[name="cogmem_chunk_mode"]');
    chunkModeRadios.forEach(r => {
        r.addEventListener('change', () => { s.chunkMode = r.value; saveSettings(); });
    });

    // 权重 / 衰减（已改为数字输入）
    bindVal('cogmem_w_relevance', 'wRelevance', v => Math.max(0, Math.min(100, parseInt(v) || 0)));
    bindVal('cogmem_w_recency', 'wRecency', v => Math.max(0, Math.min(100, parseInt(v) || 0)));
    bindVal('cogmem_w_importance', 'wImportance', v => Math.max(0, Math.min(100, parseInt(v) || 0)));
    bindVal('cogmem_decay_rate', 'decayRate', v => Math.max(0, Math.min(100, parseInt(v) || 0)));

    // 注入模板
    const tmplEl = document.getElementById('cogmem_inject_template');
    if (tmplEl) {
        tmplEl.addEventListener('input', () => { s.injectTemplate = tmplEl.value; saveSettings(); });
    }

    // 注入位置
    const radios = document.querySelectorAll('input[name="cogmem_inject_pos"]');
    radios.forEach(r => {
        r.addEventListener('change', () => { s.injectPosition = r.value; saveSettings(); });
    });
    const depthEl = document.getElementById('cogmem_inject_depth');
    if (depthEl) {
        depthEl.addEventListener('input', () => { s.injectDepth = parseInt(depthEl.value) || 2; saveSettings(); });
    }

    // 按钮
    document.getElementById('cogmem_btn_full_index')?.addEventListener('click', fullIndexCurrentChat);
    document.getElementById('cogmem_btn_browse')?.addEventListener('click', openMemoryBrowser);
    document.getElementById('cogmem_btn_sync_push')?.addEventListener('click', syncPush);
    document.getElementById('cogmem_btn_sync_pull')?.addEventListener('click', syncPull);
    document.getElementById('cogmem_btn_diag')?.addEventListener('click', diagSearch);

    // 诊断按钮
    document.getElementById('cogmem_btn_run_diag')?.addEventListener('click', runFullDiag);
    document.getElementById('cogmem_diag_plugin')?.addEventListener('click', () => { diagClear(); diagTestPlugin(); });
    document.getElementById('cogmem_diag_emb')?.addEventListener('click', () => { diagClear(); diagTestEmbedding(); });
    document.getElementById('cogmem_diag_llm')?.addEventListener('click', () => { diagClear(); diagTestScoring(); });
    document.getElementById('cogmem_diag_db')?.addEventListener('click', () => { diagClear(); diagTestDB(); });

    // 保存到服务端
    document.getElementById('cogmem_btn_save')?.addEventListener('click', async () => {
        try {
            await apiCall('/settings', {
                method: 'POST',
                body: {
                    chatTag: getChatTag(),
                    embeddingEndpoint: s.embEndpoint,
                    embeddingKey: s.embKey,
                    embeddingModel: s.embModel,
                    scoringEndpoint: s.scoreEndpoint,
                    scoringKey: s.scoreKey,
                    scoringModel: s.scoreModel,
                    weightRelevance: s.wRelevance / 100,
                    weightRecency: s.wRecency / 100,
                    weightImportance: s.wImportance / 100,
                    decayRate: s.decayRate / 100,
                    topK: s.topK,
                },
            });
            toastr.success('设置已保存到服务端');
        } catch (e) {
            toastr.error(`保存失败: ${e.message}`);
        }
    });

    // 也保存全局设置（无 chatTag）
    document.getElementById('cogmem_btn_save')?.addEventListener('dblclick', async () => {
        try {
            await apiCall('/settings', {
                method: 'POST',
                body: {
                    embedding_endpoint: s.embEndpoint,
                    embedding_key: s.embKey,
                    embedding_model: s.embModel,
                    scoring_endpoint: s.scoreEndpoint,
                    scoring_key: s.scoreKey,
                    scoring_model: s.scoreModel,
                },
            });
            toastr.success('全局默认设置已保存');
        } catch (e) {
            toastr.error(`保存失败: ${e.message}`);
        }
    });
}

// ============ 初始化 ============
(async function init() {
    const ctx = SillyTavern.getContext();

    // 检测插件
    try {
        const status = await apiCall('/status');
        pluginOnline = !!(status && (status.plugin === 'cognitive-memory' || status.status === 'ok'));
    } catch {
        pluginOnline = false;
    }

    // 渲染设置面板
    const { renderExtensionTemplateAsync } = ctx;
    const settingsHtml = await renderExtensionTemplateAsync('third-party/cognitive-memory-ext', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    // 填充 UI
    populateUI();
    bindEvents();

    // 更新状态徽章
    const badge = document.getElementById('cogmem_status_badge');
    if (badge) {
        if (pluginOnline) {
            badge.textContent = '在线';
            badge.className = 'cogmem-badge cogmem-badge-on';
        } else {
            badge.textContent = '离线';
            badge.className = 'cogmem-badge cogmem-badge-off';
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
})();

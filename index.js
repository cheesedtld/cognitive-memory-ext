/**
 * SillyTavern Server Plugin: Cognitive Memory (认知记忆引擎)
 *
 * 基于语义检索 + 情绪强度 + 重要性 + 时间衰减的智能记忆系统。
 * 支持独立使用（纯 ST）或与砖头机联动（共享记忆库）。
 *
 * 安装方法：
 * 1. 将本文件夹复制到 SillyTavern/plugins/ 目录
 * 2. cd cognitive-memory && npm install
 * 3. 在 config.yaml 中设置 enableServerPlugins: true
 * 4. 重启 SillyTavern
 *
 * API 路径: /api/plugins/cognitive-memory/...
 */

const path = require('path');
const fs = require('fs');

// ============ 数据库模块 ============

const DATA_DIR = path.join(__dirname, 'data');
let db = null;

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function getDB() {
    if (db) return db;
    ensureDataDir();
    const Database = require('better-sqlite3');
    const dbPath = path.join(DATA_DIR, 'memories.db');
    db = new Database(dbPath);

    // 启用 WAL 模式（并发读写性能更好）
    db.pragma('journal_mode = WAL');

    // 创建表
    db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            chat_tag TEXT NOT NULL,
            source TEXT DEFAULT 'st',
            text TEXT NOT NULL,
            summary TEXT,
            embedding BLOB,
            
            importance INTEGER DEFAULT 5,
            emotion_score REAL DEFAULT 0.0,
            emotion_type TEXT DEFAULT 'neutral',
            keywords TEXT DEFAULT '[]',
            
            created_at INTEGER NOT NULL,
            last_accessed INTEGER,
            access_count INTEGER DEFAULT 0,
            decay_factor REAL DEFAULT 1.0,
            
            is_core INTEGER DEFAULT 0,
            is_archived INTEGER DEFAULT 0,
            stale INTEGER DEFAULT 0
        );
        
        CREATE INDEX IF NOT EXISTS idx_chat_tag ON memories(chat_tag);
        CREATE INDEX IF NOT EXISTS idx_chat_tag_active ON memories(chat_tag, is_archived, stale);
        CREATE INDEX IF NOT EXISTS idx_importance ON memories(chat_tag, importance DESC);
        CREATE INDEX IF NOT EXISTS idx_created ON memories(chat_tag, created_at DESC);
    `);

    // 设置表（存储各 chatTag 的配置）
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            chat_tag TEXT PRIMARY KEY,
            embedding_endpoint TEXT,
            embedding_key TEXT,
            embedding_model TEXT DEFAULT 'text-embedding-3-small',
            scoring_endpoint TEXT,
            scoring_key TEXT,
            scoring_model TEXT DEFAULT 'gpt-4o-mini',
            weight_relevance REAL DEFAULT 0.5,
            weight_recency REAL DEFAULT 0.3,
            weight_importance REAL DEFAULT 0.2,
            decay_rate REAL DEFAULT 0.01,
            top_k INTEGER DEFAULT 5,
            last_sync_time INTEGER
        );
    `);

    // 全局设置（API keys 等）
    db.exec(`
        CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);

    console.log('[CogMem] 📦 数据库已初始化:', dbPath);
    return db;
}

// ============ 向量工具 ============

/**
 * 将 Float32Array 序列化为 Buffer 存入 SQLite
 */
function serializeEmbedding(arr) {
    if (!arr || arr.length === 0) return null;
    const floats = new Float32Array(arr);
    return Buffer.from(floats.buffer);
}

/**
 * 从 Buffer 反序列化为普通数组
 */
function deserializeEmbedding(buf) {
    if (!buf) return null;
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Array.from(floats);
}

/**
 * 余弦相似度
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============ Embedding API 调用 ============

/**
 * 调用 OpenAI 兼容的 Embedding API
 */
async function callEmbeddingAPI(texts, config) {
    const endpoint = (config.embedding_endpoint || '').trim().replace(/\/$/, '');
    const key = config.embedding_key || '';
    const model = config.embedding_model || 'text-embedding-3-small';

    if (!endpoint || !key) {
        throw new Error('Embedding API 未配置 (endpoint 或 key 缺失)');
    }

    let url = endpoint;
    if (!url.endsWith('/embeddings')) {
        if (url.endsWith('/chat/completions')) {
            url = url.replace('/chat/completions', '/embeddings');
        } else {
            url = url + '/embeddings';
        }
    }

    console.log(`[CogMem] 🔗 Embedding: ${texts.length} texts → ${url} (model=${model})`);
    const t0 = Date.now();

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({ model, input: texts }),
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Embedding API ${res.status}: ${txt.substring(0, 200)}`);
    }

    const data = await res.json();
    const elapsed = Date.now() - t0;
    console.log(`[CogMem] ✅ Embedding: ${data.data.length} vectors, dim=${data.data[0]?.embedding?.length || '?'}, ${elapsed}ms`);
    return data.data.map(d => d.embedding);
}

// ============ 认知评估（LLM 打分） ============

const SCORING_PROMPT = `你是一个记忆评估助手。请分析以下对话片段的重要性和情绪。

对话内容：
"""
{TEXT}
"""

请严格返回以下JSON格式（不要添加其他文字）：
{
  "importance": 1到10的整数。10=改变关系走向的重大转折（告白、分手、重大决定），1=完全无关紧要的日常闲聊（天气、吃了什么）。大部分日常对话在3-5之间,
  "emotionScore": 0到1的小数，表示情绪波动强度。0=完全平淡，1=极度激动,
  "emotionType": "joy/sadness/anger/fear/surprise/love/neutral"中的一个,
  "keywords": 最多5个关键词的数组,
  "summary": 用一句话概括这段对话的核心内容（15-30字）
}`;

/**
 * 调用 LLM 对记忆块进行认知评估
 */
async function scoringEval(text, config) {
    const endpoint = (config.scoring_endpoint || config.embedding_endpoint || '').trim().replace(/\/$/, '');
    const key = config.scoring_key || config.embedding_key || '';
    const model = config.scoring_model || 'gpt-4o-mini';

    if (!endpoint || !key) {
        // 没配置评估 LLM，返回默认值
        console.log('[CogMem] ⏭️ 评估 LLM 未配置，使用默认分值');
        return {
            importance: 5,
            emotionScore: 0.3,
            emotionType: 'neutral',
            keywords: [],
            summary: text.substring(0, 50),
        };
    }

    let url = endpoint;
    if (!url.endsWith('/chat/completions')) {
        if (url.endsWith('/embeddings')) {
            url = url.replace('/embeddings', '/chat/completions');
        } else {
            url = url + '/chat/completions';
        }
    }

    const prompt = SCORING_PROMPT.replace('{TEXT}', text.substring(0, 2000));

    try {
        console.log(`[CogMem] 🧠 Scoring: ${text.substring(0, 40)}… → ${model}`);
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
                temperature: 0.1,
            }),
        });

        if (!res.ok) {
            console.warn(`[CogMem] ⚠️ Scoring API ${res.status}, using defaults`);
            return { importance: 5, emotionScore: 0.3, emotionType: 'neutral', keywords: [], summary: text.substring(0, 50) };
        }

        const data = await res.json();
        const content = (data.choices?.[0]?.message?.content || '').trim();

        // 解析 JSON（容忍 markdown 代码块包裹）
        const jsonStr = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            importance: Math.max(1, Math.min(10, parseInt(parsed.importance) || 5)),
            emotionScore: Math.max(0, Math.min(1, parseFloat(parsed.emotionScore) || 0.3)),
            emotionType: parsed.emotionType || 'neutral',
            keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5) : [],
            summary: (parsed.summary || text.substring(0, 50)).substring(0, 100),
        };
    } catch (e) {
        console.warn('[CogMem] ⚠️ Scoring eval failed:', e.message);
        return { importance: 5, emotionScore: 0.3, emotionType: 'neutral', keywords: [], summary: text.substring(0, 50) };
    }
}

// ============ 认知检索核心 ============

/**
 * 计算认知记忆综合得分
 * score = w_rel × relevance + w_rec × recency + w_imp × importance
 */
function computeCognitiveScore(memory, queryVec, weights, now) {
    const embedding = deserializeEmbedding(memory.embedding);

    // 1. 语义相关性
    const relevance = embedding ? cosineSimilarity(queryVec, embedding) : 0;

    // 2. 时间近因（指数衰减）
    const hoursAgo = (now - (memory.created_at || now)) / (1000 * 60 * 60);
    const decayRate = weights.decay_rate || 0.01;
    const recency = Math.exp(-decayRate * hoursAgo);

    // 3. 重要性（归一化到 0-1）
    const importance = ((memory.importance || 5) / 10) * (memory.decay_factor || 1.0);

    // 4. 情绪加成（高情绪强度的记忆更不容易忘）
    const emotionBoost = 1 + (memory.emotion_score || 0) * 0.2;

    // 综合得分
    const wRel = weights.weight_relevance || 0.5;
    const wRec = weights.weight_recency || 0.3;
    const wImp = weights.weight_importance || 0.2;

    const score = (wRel * relevance + wRec * recency + wImp * importance) * emotionBoost;

    return { score, relevance, recency, importanceNorm: importance };
}

/**
 * 根据综合分判定记忆鲜活度
 */
function getVividness(score) {
    if (score > 0.7) return 'deep';     // 深刻
    if (score > 0.5) return 'clear';    // 清晰
    if (score > 0.3) return 'fading';   // 褪色
    return 'vague';                      // 模糊
}

// ============ 获取 API 配置 ============

function getConfig(chatTag) {
    const d = getDB();
    // 先查 per-chat 设置
    const perChat = d.prepare('SELECT * FROM settings WHERE chat_tag = ?').get(chatTag);
    // 再查全局设置
    const globalRows = d.prepare('SELECT key, value FROM global_settings').all();
    const global = {};
    for (const r of globalRows) global[r.key] = r.value;

    return {
        embedding_endpoint: perChat?.embedding_endpoint || global.embedding_endpoint || '',
        embedding_key: perChat?.embedding_key || global.embedding_key || '',
        embedding_model: perChat?.embedding_model || global.embedding_model || 'text-embedding-3-small',
        scoring_endpoint: perChat?.scoring_endpoint || global.scoring_endpoint || '',
        scoring_key: perChat?.scoring_key || global.scoring_key || '',
        scoring_model: perChat?.scoring_model || global.scoring_model || 'gpt-4o-mini',
        weight_relevance: perChat?.weight_relevance ?? 0.5,
        weight_recency: perChat?.weight_recency ?? 0.3,
        weight_importance: perChat?.weight_importance ?? 0.2,
        decay_rate: perChat?.decay_rate ?? 0.01,
        top_k: perChat?.top_k ?? 5,
    };
}

// ============ Express 路由 ============

async function init(router) {
    getDB(); // 初始化数据库

    // CORS
    router.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    // JSON body parser
    router.use(require('express').json({ limit: '50mb' }));

    // -------- POST /index — 存入记忆 --------
    router.post('/index', async (req, res) => {
        try {
            const { chatTag, source = 'st', chunks, autoScore = true } = req.body;
            if (!chatTag) return res.status(400).json({ error: 'Missing chatTag' });
            if (!Array.isArray(chunks) || chunks.length === 0) {
                return res.status(400).json({ error: 'chunks must be a non-empty array' });
            }

            const config = getConfig(chatTag);
            const d = getDB();
            const now = Date.now();
            const results = [];

            // 1. 批量 Embedding
            const texts = chunks.map(c => c.text);
            let embeddings;
            try {
                embeddings = await callEmbeddingAPI(texts, config);
            } catch (e) {
                console.error('[CogMem] Embedding failed:', e.message);
                return res.status(500).json({ error: 'Embedding failed: ' + e.message });
            }

            // 2. 逐个评估 + 存储
            const insertStmt = d.prepare(`
                INSERT OR REPLACE INTO memories 
                (id, chat_tag, source, text, summary, embedding, importance, emotion_score, emotion_type, keywords, created_at, last_accessed, access_count, decay_factor, is_core, is_archived, stale)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const insertMany = d.transaction(async (chunkList) => {
                for (let i = 0; i < chunkList.length; i++) {
                    const chunk = chunkList[i];
                    const id = chunk.id || `${chatTag}_${chunk.timestamp || now}_${i}`;
                    const embBuf = serializeEmbedding(embeddings[i]);

                    // 认知评估
                    let scoring = { importance: 5, emotionScore: 0.3, emotionType: 'neutral', keywords: [], summary: chunk.text.substring(0, 50) };
                    if (autoScore) {
                        scoring = await scoringEval(chunk.text, config);
                    }

                    insertStmt.run(
                        id,
                        chatTag,
                        source,
                        chunk.text,
                        scoring.summary,
                        embBuf,
                        scoring.importance,
                        scoring.emotionScore,
                        scoring.emotionType,
                        JSON.stringify(scoring.keywords),
                        chunk.timestamp || now,
                        null,
                        0,
                        1.0,
                        0,
                        0,
                        0
                    );

                    results.push({
                        id,
                        importance: scoring.importance,
                        emotionScore: scoring.emotionScore,
                        emotionType: scoring.emotionType,
                        summary: scoring.summary,
                    });
                }
            });

            // better-sqlite3 的 transaction 不支持 async，手动处理
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const id = chunk.id || `${chatTag}_${chunk.timestamp || now}_${i}`;
                const embBuf = serializeEmbedding(embeddings[i]);

                let scoring = { importance: 5, emotionScore: 0.3, emotionType: 'neutral', keywords: [], summary: chunk.text.substring(0, 50) };
                if (autoScore) {
                    scoring = await scoringEval(chunk.text, config);
                }

                insertStmt.run(
                    id, chatTag, source, chunk.text, scoring.summary, embBuf,
                    scoring.importance, scoring.emotionScore, scoring.emotionType,
                    JSON.stringify(scoring.keywords),
                    chunk.timestamp || now, null, 0, 1.0, 0, 0, 0
                );

                results.push({
                    id, importance: scoring.importance,
                    emotionScore: scoring.emotionScore,
                    emotionType: scoring.emotionType,
                    summary: scoring.summary,
                });
            }

            console.log(`[CogMem] ✅ Indexed ${results.length} chunks for ${chatTag} (source=${source})`);
            res.json({ indexed: results.length, chunks: results });
        } catch (e) {
            console.error('[CogMem] /index error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // -------- POST /search — 认知检索 --------
    router.post('/search', async (req, res) => {
        try {
            const { chatTag, query, topK, weights: customWeights } = req.body;
            if (!chatTag || !query) {
                return res.status(400).json({ error: 'Missing chatTag or query' });
            }

            const config = getConfig(chatTag);
            const d = getDB();
            const now = Date.now();
            const k = topK || config.top_k || 5;

            // Embed query
            let queryVec;
            try {
                const [vec] = await callEmbeddingAPI([query], config);
                queryVec = vec;
            } catch (e) {
                return res.status(500).json({ error: 'Embedding failed: ' + e.message });
            }

            // 获取活跃记忆
            const candidates = d.prepare(
                'SELECT * FROM memories WHERE chat_tag = ? AND is_archived = 0 AND stale = 0'
            ).all(chatTag);

            if (candidates.length === 0) {
                return res.json({ results: [], total: 0 });
            }

            // 认知打分
            const weights = {
                weight_relevance: customWeights?.relevance ?? config.weight_relevance,
                weight_recency: customWeights?.recency ?? config.weight_recency,
                weight_importance: customWeights?.importance ?? config.weight_importance,
                decay_rate: config.decay_rate,
            };

            const scored = candidates.map(mem => {
                const { score, relevance, recency, importanceNorm } = computeCognitiveScore(mem, queryVec, weights, now);
                return {
                    id: mem.id,
                    text: mem.text,
                    summary: mem.summary,
                    score,
                    relevance: Math.round(relevance * 1000) / 1000,
                    recency: Math.round(recency * 1000) / 1000,
                    importance: mem.importance,
                    emotionScore: mem.emotion_score,
                    emotionType: mem.emotion_type,
                    keywords: JSON.parse(mem.keywords || '[]'),
                    timestamp: mem.created_at,
                    source: mem.source,
                    accessCount: mem.access_count,
                    isCore: !!mem.is_core,
                    vividness: getVividness(score),
                };
            });

            scored.sort((a, b) => b.score - a.score);
            const results = scored.slice(0, k);

            // 强化效应：命中的记忆 accessCount++ 并刷新 lastAccessed
            const updateStmt = d.prepare(
                'UPDATE memories SET access_count = access_count + 1, last_accessed = ?, decay_factor = MIN(1.0, decay_factor + 0.1) WHERE id = ?'
            );
            const updateMany = d.transaction((ids) => {
                for (const id of ids) updateStmt.run(now, id);
            });
            updateMany(results.map(r => r.id));

            console.log(`[CogMem] 🔍 Search: ${candidates.length} candidates → ${results.length} hits (top: ${results[0]?.score.toFixed(3) || 'N/A'})`);
            res.json({ results, total: candidates.length });
        } catch (e) {
            console.error('[CogMem] /search error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // -------- GET /memories — 查看记忆列表 --------
    router.get('/memories', (req, res) => {
        try {
            const { chatTag, sort = 'created', limit = 100, includeArchived = 'false' } = req.query;
            if (!chatTag) return res.status(400).json({ error: 'Missing chatTag' });

            const d = getDB();
            let sql = 'SELECT * FROM memories WHERE chat_tag = ?';
            if (includeArchived !== 'true') {
                sql += ' AND is_archived = 0 AND stale = 0';
            }

            const sortMap = {
                created: 'created_at DESC',
                importance: 'importance DESC, created_at DESC',
                emotion: 'emotion_score DESC, created_at DESC',
                accessed: 'last_accessed DESC NULLS LAST',
            };
            sql += ` ORDER BY ${sortMap[sort] || sortMap.created} LIMIT ?`;

            const rows = d.prepare(sql).all(chatTag, parseInt(limit) || 100);

            const memories = rows.map(r => ({
                id: r.id,
                text: r.text,
                summary: r.summary,
                source: r.source,
                importance: r.importance,
                emotionScore: r.emotion_score,
                emotionType: r.emotion_type,
                keywords: JSON.parse(r.keywords || '[]'),
                createdAt: r.created_at,
                lastAccessed: r.last_accessed,
                accessCount: r.access_count,
                decayFactor: r.decay_factor,
                isCore: !!r.is_core,
                isArchived: !!r.is_archived,
            }));

            const stats = d.prepare(
                'SELECT COUNT(*) as total, SUM(CASE WHEN is_core = 1 THEN 1 ELSE 0 END) as core, SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END) as archived FROM memories WHERE chat_tag = ?'
            ).get(chatTag);

            res.json({ memories, stats });
        } catch (e) {
            console.error('[CogMem] /memories error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // -------- PUT /memories/:id — 更新记忆 --------
    router.put('/memories/:id', (req, res) => {
        try {
            const { id } = req.params;
            const updates = req.body;
            const d = getDB();

            const existing = d.prepare('SELECT * FROM memories WHERE id = ?').get(id);
            if (!existing) return res.status(404).json({ error: 'Memory not found' });

            const fields = [];
            const values = [];

            if (updates.importance !== undefined) { fields.push('importance = ?'); values.push(updates.importance); }
            if (updates.emotionScore !== undefined) { fields.push('emotion_score = ?'); values.push(updates.emotionScore); }
            if (updates.emotionType !== undefined) { fields.push('emotion_type = ?'); values.push(updates.emotionType); }
            if (updates.isCore !== undefined) { fields.push('is_core = ?'); values.push(updates.isCore ? 1 : 0); }
            if (updates.isArchived !== undefined) { fields.push('is_archived = ?'); values.push(updates.isArchived ? 1 : 0); }
            if (updates.summary !== undefined) { fields.push('summary = ?'); values.push(updates.summary); }
            if (updates.text !== undefined) { fields.push('text = ?'); values.push(updates.text); }

            if (fields.length === 0) return res.json({ updated: false });

            values.push(id);
            d.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);

            res.json({ updated: true });
        } catch (e) {
            console.error('[CogMem] PUT /memories error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // -------- DELETE /memories/:id — 删除记忆 --------
    router.delete('/memories/:id', (req, res) => {
        try {
            const d = getDB();
            const result = d.prepare('DELETE FROM memories WHERE id = ?').run(req.params.id);
            res.json({ deleted: result.changes > 0 });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // -------- POST /decay — 触发衰减 --------
    router.post('/decay', (req, res) => {
        try {
            const { chatTag, hoursElapsed } = req.body;
            if (!chatTag) return res.status(400).json({ error: 'Missing chatTag' });

            const config = getConfig(chatTag);
            const d = getDB();
            const decayRate = config.decay_rate || 0.01;
            const hours = hoursElapsed || 24;

            const factor = Math.exp(-decayRate * hours);

            // 更新所有非核心、非归档的记忆
            const result = d.prepare(
                'UPDATE memories SET decay_factor = decay_factor * ? WHERE chat_tag = ? AND is_core = 0 AND is_archived = 0'
            ).run(factor, chatTag);

            // 自动归档衰减过低的记忆
            const archived = d.prepare(
                'UPDATE memories SET is_archived = 1 WHERE chat_tag = ? AND is_core = 0 AND decay_factor < 0.05 AND importance <= 3'
            ).run(chatTag);

            console.log(`[CogMem] 📉 Decay: ${result.changes} memories × ${factor.toFixed(4)}, archived ${archived.changes}`);
            res.json({ decayed: result.changes, archived: archived.changes, factor });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // -------- POST /settings — 保存设置 --------
    router.post('/settings', (req, res) => {
        try {
            const { chatTag, ...settings } = req.body;
            const d = getDB();

            if (chatTag) {
                // Per-chat 设置
                d.prepare(`
                    INSERT OR REPLACE INTO settings (chat_tag, embedding_endpoint, embedding_key, embedding_model, scoring_endpoint, scoring_key, scoring_model, weight_relevance, weight_recency, weight_importance, decay_rate, top_k)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    chatTag,
                    settings.embeddingEndpoint || '', settings.embeddingKey || '', settings.embeddingModel || 'text-embedding-3-small',
                    settings.scoringEndpoint || '', settings.scoringKey || '', settings.scoringModel || 'gpt-4o-mini',
                    settings.weightRelevance ?? 0.5, settings.weightRecency ?? 0.3, settings.weightImportance ?? 0.2,
                    settings.decayRate ?? 0.01, settings.topK ?? 5
                );
            } else {
                // 全局设置
                const upsert = d.prepare('INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)');
                const saveMany = d.transaction((entries) => {
                    for (const [k, v] of entries) upsert.run(k, v);
                });
                const entries = Object.entries(settings).filter(([_, v]) => v !== undefined);
                saveMany(entries);
            }

            res.json({ saved: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // -------- GET /settings — 获取设置 --------
    router.get('/settings', (req, res) => {
        try {
            const { chatTag } = req.query;
            const d = getDB();

            const globalRows = d.prepare('SELECT key, value FROM global_settings').all();
            const global = {};
            for (const r of globalRows) global[r.key] = r.value;

            let perChat = null;
            if (chatTag) {
                perChat = d.prepare('SELECT * FROM settings WHERE chat_tag = ?').get(chatTag);
            }

            res.json({ global, perChat });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // -------- POST /sync/push — 砖头机推送记忆（兼容推拉模式） --------
    router.post('/sync/push', (req, res) => {
        try {
            const { chatTag, source = 'ztj', memories } = req.body;
            if (!chatTag) return res.status(400).json({ error: 'Missing chatTag' });
            if (!Array.isArray(memories)) return res.status(400).json({ error: 'memories must be array' });

            const d = getDB();
            const now = Date.now();

            const insertStmt = d.prepare(`
                INSERT OR REPLACE INTO memories 
                (id, chat_tag, source, text, summary, embedding, importance, emotion_score, emotion_type, keywords, created_at, last_accessed, access_count, decay_factor, is_core, is_archived, stale)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const insertMany = d.transaction((mems) => {
                for (const mem of mems) {
                    const embBuf = mem.embedding ? serializeEmbedding(mem.embedding) : null;
                    insertStmt.run(
                        mem.id || `${chatTag}_sync_${now}_${Math.random().toString(36).slice(2, 8)}`,
                        chatTag, source,
                        mem.text || '', mem.summary || '',
                        embBuf,
                        mem.importance || 5, mem.emotionScore || 0.3, mem.emotionType || 'neutral',
                        JSON.stringify(mem.keywords || []),
                        mem.timestamp || mem.createdAt || now,
                        mem.lastAccessed || null,
                        mem.accessCount || 0,
                        mem.decayFactor ?? 1.0,
                        mem.isCore ? 1 : 0, 0, 0
                    );
                }
            });

            insertMany(memories);

            // 更新同步时间
            d.prepare('INSERT OR REPLACE INTO settings (chat_tag, last_sync_time) VALUES (?, ?)').run(chatTag, now);

            console.log(`[CogMem] 📥 Sync push: ${memories.length} memories for ${chatTag} (source=${source})`);
            res.json({ success: true, received: memories.length, lastSyncTime: now });
        } catch (e) {
            console.error('[CogMem] /sync/push error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // -------- GET /sync/pull — 砖头机拉取记忆 --------
    router.get('/sync/pull', (req, res) => {
        try {
            const { chatTag, since, source } = req.query;
            if (!chatTag) return res.status(400).json({ error: 'Missing chatTag' });

            const d = getDB();
            let sql = 'SELECT * FROM memories WHERE chat_tag = ? AND is_archived = 0 AND stale = 0';
            const params = [chatTag];

            // 增量拉取：只返回 since 之后创建的
            if (since) {
                sql += ' AND created_at > ?';
                params.push(parseInt(since));
            }

            // 按来源过滤（如只拉 ST 产生的给砖头机用）
            if (source) {
                sql += ' AND source = ?';
                params.push(source);
            }

            sql += ' ORDER BY created_at DESC';
            const rows = d.prepare(sql).all(...params);

            const memories = rows.map(r => ({
                id: r.id,
                text: r.text,
                summary: r.summary,
                embedding: deserializeEmbedding(r.embedding),
                importance: r.importance,
                emotionScore: r.emotion_score,
                emotionType: r.emotion_type,
                keywords: JSON.parse(r.keywords || '[]'),
                timestamp: r.created_at,
                createdAt: r.created_at,
                lastAccessed: r.last_accessed,
                accessCount: r.access_count,
                decayFactor: r.decay_factor,
                isCore: !!r.is_core,
                source: r.source,
            }));

            console.log(`[CogMem] 📤 Sync pull: ${memories.length} memories for ${chatTag}${since ? ` (since=${since})` : ''}`);
            res.json({ memories, total: memories.length });
        } catch (e) {
            console.error('[CogMem] /sync/pull error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // -------- GET /stats — 统计信息 --------
    router.get('/stats', (req, res) => {
        try {
            const { chatTag } = req.query;
            const d = getDB();

            if (chatTag) {
                const stats = d.prepare(`
                    SELECT 
                        COUNT(*) as total,
                        SUM(CASE WHEN is_core = 1 THEN 1 ELSE 0 END) as core,
                        SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END) as archived,
                        SUM(CASE WHEN source = 'st' THEN 1 ELSE 0 END) as fromST,
                        SUM(CASE WHEN source = 'ztj' THEN 1 ELSE 0 END) as fromZTJ,
                        AVG(importance) as avgImportance,
                        AVG(emotion_score) as avgEmotion
                    FROM memories WHERE chat_tag = ?
                `).get(chatTag);
                res.json(stats);
            } else {
                // 所有角色的统计
                const stats = d.prepare(`
                    SELECT chat_tag, COUNT(*) as total,
                        SUM(CASE WHEN is_archived = 0 AND stale = 0 THEN 1 ELSE 0 END) as active
                    FROM memories GROUP BY chat_tag
                `).all();
                res.json({ characters: stats });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // -------- GET /status — 健康检查 --------
    router.get('/status', (req, res) => {
        const d = getDB();
        const count = d.prepare('SELECT COUNT(*) as c FROM memories').get();
        res.json({
            status: 'ok',
            plugin: 'cognitive-memory',
            version: '1.0.0',
            totalMemories: count.c,
            timestamp: new Date().toISOString(),
        });
    });

    console.log('[CogMem] 🧠 认知记忆插件已加载！');
    console.log('[CogMem] 📂 数据目录:', DATA_DIR);

    return Promise.resolve();
}

async function exit() {
    if (db) {
        db.close();
        db = null;
    }
    console.log('[CogMem] 插件已卸载');
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: 'cognitive-memory',
        name: 'Cognitive Memory',
        description: '认知记忆引擎 — 语义检索 + 情绪/重要性/时间衰减的智能记忆系统，支持砖头机联动',
    },
};

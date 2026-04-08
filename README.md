# 🧠 Cognitive Memory — SillyTavern 认知记忆插件

基于**语义检索 + 情绪强度 + 重要性评分 + 时间衰减**的智能记忆系统。

像人脑一样记忆：重要的事情记得深刻，琐碎的事情自然淡忘。

---

## 特性

- **认知打分**：每条记忆自动评估重要性（1-10）和情绪强度（0-1），使用便宜的 LLM（如 GPT-4o-mini）
- **智能检索**：综合语义相似度、时间近因、重要性三维加权排序
- **自然遗忘**：时间衰减机制，低重要性记忆自然褪色，被提起的记忆会加深
- **核心记忆**：可将关键记忆标为"核心"，永不衰减
- **记忆鲜活度**：检索结果标注 deep/clear/fading/vague，让 AI 知道这段记忆有多鲜活
- **砖头机联动**：支持与砖头机双向推拉同步，共享记忆库
- **独立使用**：不需要砖头机也能完整运行

---

## 安装

### 1. 复制插件

```bash
cd SillyTavern/plugins
git clone <repo-url> cognitive-memory
cd cognitive-memory
npm install
```

或手动将 `cognitive-memory/` 文件夹放入 `SillyTavern/plugins/` 目录。

### 2. 启用插件

编辑 `SillyTavern/config.yaml`：

```yaml
enableServerPlugins: true
```

### 3. 重启酒馆

看到以下日志即成功：

```
[CogMem] 🧠 认知记忆插件已加载！
[CogMem] 📦 数据库已初始化: .../plugins/cognitive-memory/data/memories.db
```

---

## API 文档

基础路径: `/api/plugins/cognitive-memory`

### POST /index — 存入记忆

```json
{
  "chatTag": "chat:小红",
  "source": "st",
  "chunks": [
    { "text": "对话文本片段", "timestamp": 1712345678000 }
  ],
  "autoScore": true
}
```

### POST /search — 认知检索

```json
{
  "chatTag": "chat:小红",
  "query": "你还记得我们之间的事吗",
  "topK": 5,
  "weights": { "relevance": 0.5, "recency": 0.3, "importance": 0.2 }
}
```

返回结果带 `vividness` 字段：deep / clear / fading / vague

### GET /memories — 查看记忆列表

```
GET /memories?chatTag=chat:小红&sort=importance&limit=50
```

### PUT /memories/:id — 更新记忆

```json
{ "importance": 9, "isCore": true }
```

### POST /decay — 触发衰减

```json
{ "chatTag": "chat:小红", "hoursElapsed": 24 }
```

### POST /sync/push — 砖头机推送记忆

```json
{
  "chatTag": "chat:小红",
  "source": "ztj",
  "memories": [{ "text": "...", "embedding": [...], "importance": 7, ... }]
}
```

### GET /sync/pull — 砖头机拉取记忆

```
GET /sync/pull?chatTag=chat:小红&since=1712345678000&source=st
```

支持增量拉取（since 参数）和按来源过滤。

### POST /settings — 保存设置

### GET /settings — 获取设置

### GET /stats — 统计信息

### GET /status — 健康检查

---

## 砖头机联动

1. 在砖头机的聊天设置中填入酒馆地址
2. 砖头机会自动调用插件的 `/sync/push` 和 `/sync/pull` 接口
3. 推拉的是完整的认知记忆块（文本+向量+元数据），不需要 AI 总结

---

## 数据存储

所有数据存储在 `plugins/cognitive-memory/data/memories.db`（SQLite 文件）。

备份只需复制此文件即可。

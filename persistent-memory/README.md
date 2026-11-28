# @ty-toolbox/persistent-memory

模型无关的持久化记忆与检索，从 `kotana-runtime` 中抽出的独立 TypeScript 包。

它负责「把记忆保存下来，并在需要时按相关度取回来」这一层：

- 记忆领域模型：分类、状态、标签、创建/更新时间校验
- 本地 JSON 文件存储：一条记忆一个文件，带 schema 版本，原子写入
- 应用服务：创建、读取、更新、归档、列表、确定性文本搜索
- 两种相关度排序器：本地主题词排序、嵌入语义排序
- 嵌入适配器：SiliconFlow（OpenAI 兼容的 `/embeddings` 协议）
- 检索服务：`MemoryRetriever` 统一处理「排序 → 嵌入失败降级 → 命中过滤 → 可选退回最近记忆」

**不包含**：会话、prompt 装配、模型 Provider、Runtime 循环、命令执行、CLI 与界面。
这些仍属于宿主运行时。

版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

```bash
npm install @ty-toolbox/persistent-memory
```

要求 Node.js >= 22。包本身没有运行时依赖。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build      # 产出 dist/index.js 与 dist/index.d.ts
```

## 用法

### 保存与读取记忆

```ts
import {
  FileMemoryStore,
  MemoryRetriever,
  MemoryService,
  TopicMemoryRanker,
} from "@ty-toolbox/persistent-memory";

const dataDir = "D:/memory-data";
const store = new FileMemoryStore({ dataDir });
const service = new MemoryService({ memoryStore: store });

const memory = await service.create({
  type: "preference",
  content: "用户喜欢清淡口味",
  tags: ["饮食"],
});

await service.update(memory.id, { tags: ["饮食", "偏好"] });
await service.archive(memory.id);
```

### 按相关度检索

```ts
const retriever = new MemoryRetriever({
  memoryStore: store,
  ranker: new TopicMemoryRanker(),
});

const result = await retriever.retrieve({
  text: "今天吃什么",
  limit: 5,
  recentOnMiss: true,
});

for (const entry of result.memories) {
  console.log(entry.memory.content, entry.score, entry.matched);
}
```

`retrieve` 的语义：

1. 只列出 `status` 指定的记忆（缺省 `active`）；
2. 用 `ranker` 排序；主排序器抛错时自动改用 `fallbackRanker`（缺省主题词排序），并在结果里标记 `degraded`；
3. 查询文本非空时只保留 `score > 0` 的记忆；为空时按更新时间倒序；
4. `recentOnMiss: true` 时，一条都没命中就退回排序器给出的全部结果（典型的 prompt 装配场景）；缺省 `false`，检索接口如实返回空。

### 启用嵌入语义检索

```ts
import {
  EmbeddingMemoryRanker,
  SiliconFlowEmbeddingProvider,
  loadEmbeddingConfig,
} from "@ty-toolbox/persistent-memory";

const embeddingConfig = loadEmbeddingConfig(); // 读取 KOTANA_EMBEDDING_*
const ranker = embeddingConfig
  ? new EmbeddingMemoryRanker({
      embedding: new SiliconFlowEmbeddingProvider({
        apiKey: embeddingConfig.apiKey,
        baseUrl: embeddingConfig.baseUrl,
        model: embeddingConfig.model,
      }),
    })
  : new TopicMemoryRanker();

const retriever = new MemoryRetriever({ memoryStore: store, ranker });
```

嵌入失败不会让检索失败：`MemoryRetriever` 会退回主题词排序，调用方可通过
`result.degraded` 与 `result.degradationReason` 记日志或提示。直接调用
`EmbeddingMemoryRanker.rank` 时异常仍会抛给上层。

## 数据目录

调用方传入数据根目录，记忆文件固定落在 `<dataDir>/memories/` 下：

```text
<dataDir>/memories/
  <encodeURIComponent(memory.id)>.json
```

文件格式与 `kotana-runtime` 兼容：

```json
{
  "schemaVersion": 1,
  "type": "memory",
  "memory": {
    "id": "memory-001",
    "type": "fact",
    "content": "用户常住上海",
    "status": "active",
    "tags": ["用户", "地点"],
    "createdAt": "2026-11-20T04:00:00.000Z",
    "updatedAt": "2026-11-20T04:00:00.000Z"
  }
}
```

写入先落临时文件再 `rename`，同一实例内的写操作由 `FileWriteQueue` 串行化。
多个存储实例共享同一目录时，可显式传入同一个 `FileWriteQueue`。

## 与 kotana 的兼容性

- 记忆文件格式保持一致：`memories/*.json` 仍是 `{ schemaVersion: 1, type: "memory", memory }`，可以直接指向 kotana 已有的数据目录。
- `FileMemoryStore` 不再读取 `KOTANA_DATA_DIR`，`dataDir` 必须显式传入；这是与来源项目最主要的 API 差异。
- `loadEmbeddingConfig` 默认仍读取 `KOTANA_EMBEDDING_*`，需要时可用 `prefix` 改前缀。
- `MemoryRetriever` 默认在没有任何命中时返回空；要保留 kotana `RuntimeService`「无命中退回最近记忆」的行为，检索时传 `recentOnMiss: true`。
- `MemoryService.search()` 仍是本地确定性文本搜索；语义检索由 `MemoryRetriever` 搭配 `EmbeddingMemoryRanker` 完成。

## 公开 API

| 分类 | 导出 |
| --- | --- |
| 领域模型 | `createMemory`、`updateMemory`、`archiveMemory`、`Memory`、`MemoryType`、`MemoryStatus`、`CreateMemoryInput`、`UpdateMemoryInput` |
| 应用服务 | `MemoryService`、`MemoryRetriever`、`CreateMemoryCommand`、`UpdateMemoryCommand`、`MemoryServiceOptions`、`MemoryRetrieverOptions`、`RetrieveMemoriesOptions`、`MemoryRetrievalResult` |
| 排序 | `TopicMemoryRanker`、`EmbeddingMemoryRanker`、`EmbeddingMemoryRankerOptions`、`RankedMemory`、`MemoryRankQuery` |
| 端口 | `MemoryStore`、`MemoryListOptions`、`MemorySearchOptions`、`MemoryRanker`、`EmbeddingProvider`、`EmbeddingRequest` |
| 文件存储 | `FileMemoryStore`、`FileMemoryStoreOptions`、`FileWriteQueue` |
| 嵌入 | `SiliconFlowEmbeddingProvider`、`SiliconFlowEmbeddingError`、`SiliconFlowEmbeddingOptions` |
| 配置 | `loadEmbeddingConfig`、`EmbeddingConfig`、`LoadEmbeddingConfigOptions` |

`MemoryService.search()` 走存储的本地确定性文本搜索（中文整段 + 二元组、英文词）；
`MemoryRetriever.retrieve()` 走可替换的排序器，适合「按当前输入取相关记忆」。

## 环境变量

`loadEmbeddingConfig` 默认读取以下变量（可用 `env` 注入，`prefix` 改前缀）：

| 变量 | 作用 |
| --- | --- |
| `KOTANA_EMBEDDING_PROVIDER` | `siliconflow` 开启嵌入检索；`""` / `none` / `off` / `false` / `0` 关闭 |
| `KOTANA_EMBEDDING_API_KEY` | SiliconFlow API Key；启用时必填 |
| `KOTANA_EMBEDDING_BASE_URL` | API 地址，默认 `https://api.siliconflow.cn/v1` |
| `KOTANA_EMBEDDING_MODEL` | 嵌入模型，默认 `BAAI/bge-m3` |

默认关闭：只有显式设置 provider 才启用，避免「有 Key 就偷偷联网」。启用后每条记忆
最多 1000 字符会发送到嵌入接口；向量只缓存在进程内，不落盘。

## 发布（维护者）

```bash
pnpm typecheck && pnpm test && pnpm build
pnpm pack --dry-run
npm publish --registry https://registry.npmjs.org/ --access public
```

默认 registry 可能是镜像；发布时必须显式指定 npmjs。

## 许可

自有代码 MIT，来源与改动说明见 [NOTICE.md](NOTICE.md)。

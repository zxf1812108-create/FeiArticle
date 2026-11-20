import { ArticleDoc, FolderNode } from '../types';
import { extractExcerpt, getByteSize } from '../utils/textParser';

const now = Date.now();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export const INITIAL_FOLDERS: FolderNode[] = [
  { id: 'folder-arch', name: '技术方案', parentId: null, order: 0, updatedAt: now - 2 * HOUR },
  { id: 'folder-essays', name: '阅读随笔', parentId: null, order: 1, updatedAt: now - 1 * DAY },
  { id: 'folder-templates', name: '写作模板', parentId: null, order: 2, updatedAt: now - 4 * DAY },
];

function makeDoc(params: {
  id: string;
  title: string;
  folderId: string | null;
  order: number;
  content: string;
  contentHash: string;
  tags: string[];
  starred?: boolean;
  readProgress?: number;
  updatedAt: number;
  createdAt: number;
  syncStatus?: 'synced' | 'dirty';
}): ArticleDoc {
  return {
    id: params.id,
    title: params.title,
    folderId: params.folderId,
    order: params.order,
    content: params.content,
    contentHash: params.contentHash,
    excerpt: extractExcerpt(params.content),
    tags: params.tags,
    starred: Boolean(params.starred),
    readProgress: params.readProgress ?? 0,
    lastReadAt: params.readProgress ? params.updatedAt : null,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
    syncStatus: params.syncStatus ?? 'synced',
    highlights: [],
    byteSize: getByteSize(params.content),
  };
}

export const INITIAL_DOCUMENTS: ArticleDoc[] = [
  makeDoc({
    id: 'doc-android-arch',
    title: 'FeiArtical 安卓端 + 坚果云高效同步技术方案',
    folderId: 'folder-arch',
    order: 0,
    starred: true,
    readProgress: 24,
    updatedAt: now - 15 * 60 * 1000,
    createdAt: now - 3 * DAY,
    contentHash: 'arch_v1_9a4c2e10',
    tags: ['Android', '坚果云', '架构设计'],
    content: `# FeiArtical 安卓端 + 坚果云高效同步技术方案

面向数百篇文本文档（约 300–1000 篇、总大小 5–30 MB）的个人阅读与管理场景，核心难点不在于解析文本，而在于**如何兼顾树形目录的高频调整**与**坚果云免费版的流量/频率限制**。

## 一、坚果云免费版核心限制摸底

设计同步协议前，必须锚定坚果云免费版的硬约束：

- **月上传流量上限**：1 GB / 月
- **月下载流量上限**：3 GB / 月
- **WebDAV 频率限制**：每 30 分钟约 600 次请求（触发后返回 HTTP 503 / 429）
- **鉴权方式**：邮箱账号 + 第三方应用密码（HTTP Basic Auth，路径固定为 \`https://dav.jianguoyun.com/dav/你的目录/\`）

如果采用传统网盘同步思路（每次打开 App 递归 \`PROPFIND\` 遍历所有子目录、重命名分类时逐个 \`MOVE\` 文件、编辑时每秒自动上传），几百篇文档极易在几天内触发限流或耗尽月流量。

## 二、高效省流的核心存储架构：正文扁平 + 树形索引分离

不要用坚果云的物理文件夹来表达文档树！推荐采用**「索引文件 + 扁平正文」**双层结构：

\`\`\`text
/dav/FeiArtical/
├── _manifest.json          # 全局索引：完整树形目录、自定义排序、标题、摘要、SHA-256 哈希
└── docs/
    ├── doc_8f3a1c.md       # 每篇文档按不可变 UUID 平铺存储（纯文本 / Markdown）
    ├── doc_2b9d4e.md
    └── ...
\`\`\`

### 为什么这种结构极度省流？

1. **调整分类与排序零文件迁移**：拖拽文档换文件夹、重命名节点、调整 50 篇文章顺序，只修改 \`_manifest.json\`（500 篇文章的索引仅约 45 KB，gzip 后约 15 KB），**1 次 PUT 请求即可完成**，无需发几十次 WebDAV \`MOVE\` / \`MKCOL\`。
2. **启动秒开目录树**：新手机首次登录时，只下载 1 个 \`_manifest.json\`（~45 KB），即可瞬间渲染出全部几百篇文章的树形结构与标题，无需递归扫描文件夹。
3. **跨端兼容与可读性**：单篇文件依然是标准 UTF-8 纯文本/Markdown，即使脱离软件，在坚果云网页版也能直接打开阅读。

## 三、免费版防超额四大关键策略

### 1. ETag 条件检查（HTTP 304 零流量）

每次触发同步时，先携带上次缓存的 \`ETag\` 请求 \`_manifest.json\`：

\`\`\`http
GET /dav/FeiArtical/_manifest.json HTTP/1.1
If-None-Match: "etag-from-last-sync"
\`\`\`

如果云端无变化，坚果云直接返回 \`304 Not Modified\`——**只消耗 1 次请求、0 字节下载流量**。

### 2. SHA-256 内容哈希增量 Diff

本地数据库（Room / SQLite）为每篇文档保存 \`contentHash\`。同步时仅比对 \`localHash !== remoteHash\` 的文档：

- 修改 1 篇 8 KB 的文章后同步：仅上传 \`docs/{id}.md\`（8 KB）+ \`_manifest.json\`（45 KB），共 **2 次请求、约 53 KB**。
- 即使每天编辑并同步 20 次，全月上传流量也仅约 **30 MB**，不到免费额度（1 GB）的 **3%**。

### 3. 按需拉取正文（Lazy Pull）与本地永久缓存

- 500 篇文章全部在本地 SQLite 缓存正文，离线随时秒开阅读。
- 若在其他设备新增了 20 篇文章，手机端默认先拉取索引；仅在点击阅读某篇时按需 \`GET docs/{id}.md\` 并永久写入本地缓存，或提供「Wi-Fi 下一键缓存全部未下载正文」按钮。

### 4. 本地优先 + 脏队列合并上传（绝不按键实时上传）

- 编辑时 100% 写入本地数据库，标记 \`sync_status = DIRTY\`，保证飞记（FeiNote）般的零延迟手感。
- **合并推送策略**：退出编辑页后延迟 15–30 秒合并上传，或由用户手动点击顶部同步按钮触发批量推送；若连续编辑同一篇文章 10 分钟，最终只上传 1 次。

## 四、冲突处理方案（轻量稳妥）

个人多端阅读编辑的冲突概率极低，推荐采用**「字段级 LWW + 正文冲突副本」**：

- 目录树排序与阅读进度：按节点级 \`updatedAt\` 时间戳以最新为准。
- 正文同时在两端被修改（本地 \`DIRTY\` 且云端 \`remoteHash !== baseHash\`）：不静默覆盖，自动保留云端版本并生成一篇《原名（冲突副本 MM-DD HH:mm）》放入同目录，由用户从容合并。

## 五、安卓端极简高效技术栈推荐（FeiNote 风格）

> 如果希望开发速度最快、安装包小、滚动如丝般顺滑，优先选择原生 Jetpack Compose 体系。

- **UI 框架**：Jetpack Compose + Material 3（去冗余阴影、纯白/深灰高对比、1dp 极细分割线，贴合飞记极简视觉）
- **本地存储**：Room (SQLite) + FTS4/FTS5 全文检索（几百篇文档毫秒级全文搜索）
- **网络与 WebDAV**：OkHttp 4（原生支持 \`If-None-Match\` / \`ETag\` / gzip 压缩，无需笨重第三方 WebDAV SDK，300 行 Kotlin 即可写出极稳的专用客户端）
- **后台同步调度**：WorkManager（仅在存在脏数据且网络可用时触发，支持设置仅 Wi-Fi 同步）
- **Markdown 渲染**：Markwon 或自研轻量 Compose 段落渲染器（方便做阅读进度记忆与划词高亮）

### 预估开发里程碑（单人业余开发约 2–3 周）

1. **第 1 周**：Room 表结构（Folders / Articles / Highlights）+ 树形列表页面 + 飞记风格阅读/编辑页。
2. **第 2 周**：OkHttp 坚果云 WebDAV 增量同步引擎（\`_manifest.json\` Diff + ETag 304 + 脏队列）+ 冲突副本保护。
3. **第 3 周**：FTS5 全文搜索、阅读排版调节、本地批量导入 \`.txt/.md\`、流量统计面板打磨。

你可以在本应用的左侧边栏点击**「坚果云同步」**，直接体验这套协议的实时连接或离线演练。`,
  }),
  makeDoc({
    id: 'doc-manifest-spec',
    title: 'WebDAV 协议与 _manifest.json 数据结构规范',
    folderId: 'folder-arch',
    order: 1,
    starred: false,
    readProgress: 0,
    updatedAt: now - 2 * HOUR,
    createdAt: now - 3 * DAY,
    contentHash: 'spec_v1_7e31c4b2',
    tags: ['WebDAV', '协议规范', 'Kotlin'],
    content: `# WebDAV 协议与 _manifest.json 数据结构规范

为了在不依赖后端服务器的前提下实现高性能树形管理，客户端只需和坚果云交互 4 个最基础的 HTTP 方法：\`PROPFIND\`、\`MKCOL\`、\`GET\`、\`PUT\`。

## 一、_manifest.json 标准结构

\`\`\`json
{
  "version": 1,
  "updatedAt": 1763598000000,
  "folders": [
    {
      "id": "folder-arch",
      "name": "技术方案",
      "parentId": null,
      "order": 0,
      "updatedAt": 1763591000000
    }
  ],
  "docs": {
    "doc-android-arch": {
      "id": "doc-android-arch",
      "title": "FeiArtical 安卓端 + 坚果云高效同步技术方案",
      "folderId": "folder-arch",
      "order": 0,
      "contentHash": "arch_v1_9a4c2e10",
      "excerpt": "面向数百篇文本文档的个人阅读与管理场景...",
      "tags": ["Android", "坚果云"],
      "starred": true,
      "readProgress": 24,
      "updatedAt": 1763598000000,
      "byteSize": 4820
    }
  }
}
\`\`\`

## 二、Android OkHttp 极简 WebDAV 核心代码片段

无需引入复杂的 Sardine/Jackrabbit 库，用 \`OkHttpClient\` 即可完整控制超时、ETag 与流量统计：

\`\`\`kotlin
class JianguoDavClient(
    private val baseUrl: String,
    username: String,
    appPassword: String
) {
    private val authHeader = Credentials.basic(username, appPassword)
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    fun fetchManifest(lastEtag: String?): Pair<Int, String?> {
        val req = Request.Builder()
            .url(baseUrl.trimEnd('/') + "/_manifest.json")
            .header("Authorization", authHeader)
            .apply { if (!lastEtag.isNullOrBlank()) header("If-None-Match", lastEtag) }
            .get()
            .build()

        client.newCall(req).execute().use { resp ->
            if (resp.code == 304) return 304 to null
            return resp.code to resp.body?.string()
        }
    }
}
\`\`\`

## 三、树形排序的稳妥实现

建议给每个文件夹与文档维护一个数值 \`order\`（或采用 Fractional Indexing 分数排序，如 \`1000, 2000, 3000\`，插入中间时取 \`1500\`）。

- 好处：拖拽移动 1 篇文章时，**只改动这一条记录的 \`order\` 与 \`updatedAt\`**，不会导致同目录下其他 30 篇文章的时间戳全部变化，极大减少合并冲突概率。`,
  }),
  makeDoc({
    id: 'doc-slow-reading',
    title: '纸页与屏幕之间：谈长文阅读的排版节制',
    folderId: 'folder-essays',
    order: 0,
    starred: true,
    readProgress: 68,
    updatedAt: now - 1 * DAY,
    createdAt: now - 5 * DAY,
    contentHash: 'essay_v1_4d8f11aa',
    tags: ['阅读', '排版'],
    content: `# 纸页与屏幕之间：谈长文阅读的排版节制

好的阅读工具应当像一间安静的书房：推门而入时，目光所及只有文字与留白，工具本身退居幕后。

## 一、行宽决定眼睛的呼吸

印刷书籍历经五百年演化，中文单行通常落在 **28 至 38 个汉字**之间。在宽屏显示器或平板上，如果让正文毫无节制地铺满整个视口，视线从行尾折返下一行行首时极易错行，阅读疲劳感会成倍上升。

将正文容器收敛到 \`680px\` 左右的适中版心，再辅以 \`1.75–1.9\` 的宽松行高，长文就会自然呈现出纸面般的节奏感。

## 二、克制的层级，而非喧宾夺主的装饰

很多笔记软件热衷于给每一条元数据套上五颜六色的胶囊标签，或者在段落左侧画出粗重的色条。短期看似乎「丰富」，但在真正需要沉浸阅读两千字以上的文档时，这些高饱和度的色块都在不断争抢注意力。

> 排版最高的礼貌，是让读者忘记排版的存在。

当分类、字数、更新时间以低对比度的纯文本排列，仅用轻盈的间隔号分隔，视线便能毫无阻碍地落入正文第一句。

## 三、本地优先带来的笃定感

无论是手机端还是桌面端，点击一篇文档时若总要等待转圈加载，思考的连贯性就会被打断。把几百篇珍藏文本完整沉淀在本地存储中，再通过静默的增量协议与云端对齐，既保有云端备份的安心，又拥有打开本地纸书般的干脆利落。`,
  }),
  makeDoc({
    id: 'doc-reading-book',
    title: '《如何阅读一本书》核心方法摘录',
    folderId: 'folder-essays',
    order: 1,
    starred: false,
    readProgress: 45,
    updatedAt: now - 2 * DAY,
    createdAt: now - 8 * DAY,
    contentHash: 'book_v1_3c09b5e2',
    tags: ['读书笔记', '方法论'],
    content: `# 《如何阅读一本书》核心方法摘录

莫提默·艾德勒将阅读划分为四个逐层递进的层次：基础阅读、检视阅读、分析阅读与主题阅读。

## 一、检视阅读的两步法

在决定是否精读一本长文档前，先花十分钟做结构性浏览：

1. 看标题、序言与完整目录，迅速建立全书骨架。
2. 挑选与主题最相关的两三个章节，重点读首尾段落，判断作者的核心论点是否值得投入时间。

## 二、分析阅读的四个基本问题

主动阅读的本质，是带着问题与作者对话：

- **整体而言，这篇文档到底在谈什么？**
- **作者细部说了什么，怎么说的？**
- **这篇文章说得有道理吗？是全部有道理，还是部分有道理？**
- **这篇内容与我当下正在做的事有什么关系？**

## 三、主题阅读与树形归档

当你手里积累了数百篇围绕特定领域的文本文档时，单一时间线已经不够用了。按照**「主题 → 子问题 → 具体资料」**建立树形分类，并在阅读时直接划词高亮、写下批注，零散文章才会真正沉淀为个人知识体系。`,
  }),
  makeDoc({
    id: 'doc-knowledge-org',
    title: '信息过载时代的知识整理原则',
    folderId: 'folder-essays',
    order: 2,
    starred: false,
    readProgress: 10,
    updatedAt: now - 3 * DAY,
    createdAt: now - 10 * DAY,
    contentHash: 'org_v1_5b22e8a1',
    tags: ['知识管理', '效率'],
    content: `# 信息过载时代的知识整理原则

收藏不等于掌握，目录过深反而会成为阅读的阻力。

## 原则一：目录层级不超过三层

树形结构非常适合个人文档库，但深度建议控制在 **2–3 层**。超过四层的嵌套会让找文档变成走迷宫；更细颗粒度的横向关联，交给全文检索与简短标签去完成。

## 原则二：用纯文本对抗软件生命周期

软件会更迭，封闭格式会失效，但 UTF-8 编码的 \`.txt\` 与 \`.md\` 文件在二十年后依然可以被任何设备瞬间打开。把文本存放在自己掌控的坚果云目录里，是个人数字资产最稳妥的长期策略。

## 原则三：定期清理与重读

每个周末抽出二十分钟，浏览一遍「收藏」或「最近阅读」中的高亮批注，把真正有价值的洞见提炼成自己的短文，其余过时资料果断移入归档。`,
  }),
  makeDoc({
    id: 'doc-markdown-guide',
    title: '飞记风格 Markdown 写作与阅读排版速查',
    folderId: 'folder-templates',
    order: 0,
    starred: false,
    readProgress: 0,
    updatedAt: now - 4 * DAY,
    createdAt: now - 12 * DAY,
    contentHash: 'tpl_v1_1f88c3d9',
    tags: ['模板', 'Markdown'],
    content: `# 飞记风格 Markdown 写作与阅读排版速查

在 FeiArtical 中，无论是纯文本 \`.txt\` 还是标准 Markdown \`.md\` 都可以获得清晰的排版与自动目录识别。

## 标题与自动目录

使用 \`#\`、\`##\`、\`###\` 定义各级标题；对于导入的中文纯文本小说或长文，软件也会自动识别类似「第一章」「一、」这样的章节标题并生成右侧目录。

## 行内样式与引用

支持 **加粗强调**、*斜体* 以及 \`行内代码\` 标记。引用段落采用柔和底色与优雅缩进呈现：

> 极简不是功能的匮乏，而是把每一处干扰都挪出视线之外。

## 快捷操作建议

- 点击右上角**「编辑」**即可切换至无干扰写作视图，实时保存在本地并标记待同步。
- 在阅读模式下直接**选中任意一段文字**，即可呼出划词菜单进行高亮或撰写批注。
- 支持将电脑上的多个 \`.txt\` 或 \`.md\` 文件直接拖入窗口批量导入（自动兼容 UTF-8 与 GBK 编码）。`,
  }),
];

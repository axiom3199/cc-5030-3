# 远程剪辑协作原型（collab-video-edit-prototype）

基于稳定片段身份、可重放操作日志、显式冲突与精确媒体时间的多端协作剪辑原型。

## 图形入口（协作剪辑主路径）

启动服务后，用浏览器打开（两个面板即两个编辑端，各自持有独立 WebSocket 连接）：

- 编辑端 Alice：`http://localhost:8080/?editor=alice`
- 编辑端 Bob：`http://localhost:8080/?editor=bob`
- 单页双端总览：`http://localhost:8080/`

图形界面支持：表单提交 insert/trim/split/move/remove、在时间线上**拖动片段**（拖放被转换为内核 move 操作，与表单走同一套并发规则）、断线重连重放、重复消息幂等、显式冲突与重试、按最终时间线解码真实帧、以及每条已确认记录的**内核撤销**按钮。面板上的 `collab-oplog v2` 徽标标明当前操作日志格式版本。

## 运行

```bash
npm run media     # 生成真实 PNG 帧素材（ImageMagick）
npm start         # 默认 http://localhost:8080，日志落盘 data/oplog.log
npm test          # node:test 协作契约 + 日志迁移测试（共 24 个）
npm run smoke     # 双端 WebSocket 端到端冒烟
npm run ui        # 真实浏览器 UI 验证（拖动、切端收敛、撤销、v2 徽标）
```

服务端默认把 v2 操作日志写入 `data/oplog.log`，重启时从该日志重建时间线。
设置 `OPLOG_FILE=`（空值）可退回纯内存历史；`PORT` 可改监听端口。

## 操作日志格式与迁移版本

- **当前版本：`collab-oplog` formatVersion 2（随 v2.0.0 引入，即操作日志迁移版本）。**
- v2 记录显式携带三要素：
  - 对象身份：`result.targets[].clipId`（外加 `op.clientId` / `op.opId`、顶层 `clipIds`）
  - 基准修订：`result.baseRevision`（操作所依据的服务端版本）
  - 操作结果：`result.outcome`（applied/rejected）、`result.revision`，以及应用前后的完整片段快照 `result.targets[].before/after`
- 每条记录带全局 `recNo`，已应用记录带单调连续的 `seq`。**加载顺序只认 `seq`/`recNo`，不依赖文件行序**；重复 seq 或断档会显式报错。
- 旧的 v1 记录（内存 `store.log`/`store.rejects` 形状，或 `/api/log` 导出的
  `{applied, rejected}` bundle / JSONL）由转换器迁移为 v2。

### 命令行仅作辅助

CLI 只用于检查和迁移日志，协作剪辑本身在图形面板中完成：

```bash
# v1 -> v2 转换；未知/损坏记录原样字节保存在 sidecar，且进程非零退出，
# 缺少可用 baseVersion 的修改类记录不会被默认值掩盖
npm run migrate:oplog -- --in old-v1.json --out data/oplog.log \
  --sidecar data/oplog.unknown.jsonl --sources media/manifest.json

# 校验 v2 日志能重建出一致时间线并输出完整性摘要
npm run verify:oplog -- --oplog data/oplog.log
```

迁移期应用记录会通过真实 `TimelineStore` 重放来计算 before/after 快照，
而不是猜测数值；迁移前后实际渲染（render plan）与撤销语义保持一致
（由 `test/migration.test.js` 锁定）。

## 关键模块

| 文件 | 职责 |
| --- | --- |
| `src/oplog.js` | v2 日志格式、记录构造、读取/排序、追加 sink |
| `src/store.js` | 协作剪辑内核：字段级乐观并发、逆操作撤销、从 v2 日志重建 |
| `src/server.js` | HTTP/WS 协议、日志持久化与重启恢复、undo 消息 |
| `scripts/migrate_oplog.js` | v1 -> v2 剪辑日志转换器（未知记录保字节、不靠默认值遮错） |
| `scripts/verify_oplog.js` | 命令行辅助校验 |
| `public/collab.js` | 前端协作内核（传输/状态，无 DOM） |
| `public/app.js` | 薄视图层：控件由 `CollabSession` 内核驱动，失败反馈回协作面板 |

# 离线航迹交换站 · 写时复制 B+ 树索引复核台

浏览器内完成全部计算、用 IndexedDB 持久化的航点索引系统。索引为**阶数 4 的 B+ 树**，
每个批次对受影响路径做**写时复制（COW）**，并按严格三阶段落盘，保证断电重开后
航点索引只会停在**旧根**或**完整新根**，半写入页绝不混入可查询视图。

## 一、持久化协议（三阶段）

每个批次只写新页、从不原地改旧页；页 id 由内容（含代次）摘要派生，天然内容寻址、
等价重试幂等。

| 阶段 | 动作 | 断电后果 |
| ---- | ---- | -------- |
| 1 · PAGES | 逐页持久化全部新页（带 `gen` 代次与 `digest` 摘要） | 无意图，新页是旧根不可达的孤儿，重开清除并停在旧根 |
| 2 · INTENT | 留下批次意图（batchId、编辑摘要、新根、新页清单、键集合） | 重开只凭已落盘证据判定：证据完整则发布新根，否则退回旧根 |
| 3 · COMMIT | **同一 IndexedDB 事务**原子切换根指针（携带已提交键集合）并固化提交回执，随后清理意图与旧版本页 | 根与回执同生共死；根已切则重开仅补清理，确认新根 |

重开复核（刷新页面或点“断电后重开复核”）严格依据持久化证据给出结论：

- `FRESH`：空库；
- `INTACT`：无未完成批次，停在旧根（并回收上次阶段 1 的半写入孤儿）；
- `NEW_ROOT_PUBLISHED`：意图与全部新页完整且从根可闭合遍历 → 发布新根；
- `OLD_ROOT_RETAINED`：新页缺失 / 摘要损坏 / 引用无法闭合 → 保留旧根、剔除孤儿、记录回滚原因；
- `PUBLISHED_ROOT_UNHEALTHY`：已发布根自身缺页或摘要损坏 → 冻结，任何批次不得改变该根。

## 二、批次与回执规则

- 初始录入：至多 **24** 个互异整数键 + 短文本载荷。
- 每批：稳定**批次标识** + 至多 **12** 项顺序脚本（插入 / 更新 / 删除）。
- **相同批次标识 + 等价编辑**（操作类型、键、载荷归一化后相同）重试 → 回放原回执，不再次改根、代次不前进。
- **相同批次标识但内容不同** → `CONFLICT_BATCH_CONTENT` 冲突拒绝，已发布根不变。
- 重复插入（含批次执行点已存在）`INSERT_EXISTS`；删除 / 更新不存在键 `DELETE_MISSING` / `UPDATE_MISSING`；
  新页或已发布页摘要损坏 `CORRUPT_DIGEST`；子页引用无法闭合 `BROKEN_REFERENCE`。
  所有拒绝都给出中文原因，且**不产生任何写入、不改变已发布根**。
- 批次是顺序脚本：允许“先插入后更新/删除”同一键。
- **预演（只读，不触碰已发布根）**：提交前可在内存推演当前脚本，展示所依据根代次 / 根指针、
  规范化脚本摘要、候选根摘要、预计新增与提交后不再可达的页数 / 键数、按键有序叶序列，
  以及**每项编辑后**的键序与分裂 / 提升 / 合并 / 收缩 / 借位事件；重复插入、缺失更新或删除
  沿用与正式提交**完全相同的中文拒因**。预演不写页、不留意图、不产生回执。
- **预演失效**：预演绑定启动时的根指针与规范化脚本；刷新页面、初始索引变更、重新录入任一
  编辑（增删改任一行、改批次标识）或已发布根因提交 / 恢复而变化，旧预演立即明确失效，
  旧候选不得当作可提交结果。基准仍一致时提交同一批次，必然得到与预演相同的键序与页结构
  （内容寻址下候选根 id 即提交根 id）；根已变化时页面先要求重新预演（等价回执回放与
  中断续做行为不受影响）。

## 三、结果页展示

- 根代次、可达页数、内部页 / 叶页数、键总数；
- 根指针 id；
- **分裂审计**：独立比较「中序遍历叶页所得键」与「根记录携带的已提交键集合」，
  报告是否严格有序、每键恰好一次、有无丢失 / 多余 / 重复；
- 按键有序的叶序列（叶页交替底色，直观看到分裂后每键仅落在唯一叶页）；
- **预演候选与已发布视图并列**：候选侧以独立配色明确标注“仅在内存中计算，未写入页 / 意图 / 回执”，
  已发布侧始终取自当前 IndexedDB 根；预演失效时候选区收起并给出失效原因，重开页面不会把旧候选误认为真实批次；
- 每个可达页的代次、深度、分隔键 / 键值、摘要；
- 中断后的恢复结论横幅。

## 四、用 Compose 运行与验收

```bash
docker compose build
docker compose up web                         # 静态站点 http://localhost:8080，/healthz 返回 ok
docker compose --profile verify run --rm verify
echo $?                                       # 0 = 规则测试 + 页面构建 + HTTP 冒烟全过
```

`verify` 容器位于 `verify` profile 下（故普通 `docker compose up` 只启动站点），
在 `web` 健康后运行（`depends_on: service_healthy`）：

1. `node --test`：40+ 项规则 / 只读预演 / 集成 / 页面控制层测试（有效分裂、四个持久化阶段中断恢复、
   冲突与等价重传、各类拒绝原因、损坏摘要、无法闭合引用、预演与提交同根及失效门禁、IndexedDB 适配层端到端、DOM 事件路径）；
2. 页面“构建”：本站为零打包原生 ES 模块，构建 = 结构与引用校验 + 全部 JS `node --check` + 汇总到 `dist/`；
3. HTTP 冒烟：`/healthz`、`/`、样式与全部 ES 模块资源可达、404 行为。

完成后以退出码交付结论（0 通过 / 非零失败）。

## 五、无 Docker 的本机复核（仅需 Node ≥ 20，零依赖）

```bash
node --test verify/rules.test.mjs verify/preview.test.mjs verify/idb.integration.test.mjs verify/dom.test.mjs
node verify/build.mjs
PORT=8090 node verify/dev-server.mjs dist &      # 或直接指向 site
BASE_URL=http://localhost:8090 node verify/smoke.mjs
# 一条命令（先起服务，再自动等待健康并跑完全部环节）：
PORT=8091 node verify/dev-server.mjs dist & sleep 1; BASE_URL=http://localhost:8091 node verify/run-all.mjs
```

## 六、目录结构

```
site/
  index.html          录入 / 批次 / 断电演练 / 结果页
  styles.css
  app.mjs             浏览器控制层（事件、渲染、IndexedDB 连接）
  src/
    bptree.mjs        阶数 4 B+ 树：路径 COW、分裂、借位、合并
    digest.mjs        FNV-1a 64 位页摘要（UTF-8、稳定 JSON）
    engine.mjs        三阶段提交、断电恢复、回执重放、只读快照与分裂审计
    store.mjs         IndexedDB 适配（putMany 单事务）+ 内存适配
docker/
  Dockerfile.web      nginx 静态站 + 健康检查
  Dockerfile.verify   node:20-alpine 验收容器
  nginx.conf          /healthz 与 .mjs MIME
verify/
  rules.test.mjs      规则测试
  preview.test.mjs    只读预演测试（无写入、与提交同根、失效门禁、逐项事件、同源拒因）
  idb.integration.test.mjs  IndexedDB 适配层端到端（垫片）
  dom.test.mjs        页面控制层事件路径（精简 DOM 垫片）
  fake-idb.mjs        极简 IndexedDB 垫片
  build.mjs / smoke.mjs / dev-server.mjs / run-all.mjs
docker-compose.yml
```

## 七、设计要点说明

- **为何查询视图永远不会半新半旧**：根指针是唯一入口；阶段 1/2 只产生旧根不可达的数据，
  阶段 3 用单事务切换根。任何崩溃点后，库里的根要么是旧根要么是新根。
- **为何叶序列不需要 next 指针**：按树结构对子节点顺序做中序遍历即得严格键序，
  避免写时复制下叶间链在分裂 / 合并时的脆弱维护。
- **“恰好一次”如何独立证明**：树遍历结果与根记录中随根原子提交的键集合双向比对，
  任何分裂丢键 / 重复都会在结果页暴露。
- 摘要为 FNV-1a 64 位，用于检测意外损坏 / 篡改，不提供密码学抗碰撞保证。
- **为何预演必然可信**：预演与提交共用 `planEdits` 同一套 COW 树算法和同一个校验链
  （标识 / 数量 / 键型 / 重传冲突 / 冻结门禁 / 顺序规则），且页 id 内容寻址——
  基准一致时预演算出的候选根 id 就是提交后写入的根 id，无需另写一套“预测逻辑”而产生偏差。
  预演结果只存页面内存（不落 IndexedDB、不写 sessionStorage），刷新后物理上不可能残留为“批次”。

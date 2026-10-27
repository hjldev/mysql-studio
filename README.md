# MySQL Studio

一个用 **Tauri 2 + React + TypeScript** 实现的、类似 Navicat 的 MySQL 图形化管理工具。后端使用 Rust（`mysql_async`），前端使用 CodeMirror 6 作为 SQL 编辑器、自研虚拟滚动数据表格。

## 功能

**连接管理**
- 新建 / 编辑 / 复制 / 删除连接，支持默认数据库、SSL（可允许无效证书）、连接颜色标记
- 测试连接；连接配置保存在应用配置目录的 `connections.json`（文件权限 0600）

**对象浏览**
- 左侧对象树：连接 → 数据库 → 表 / 视图 / 函数（存储过程、函数）/ 触发器，懒加载
- 对象搜索过滤；右键菜单覆盖常用操作
- 「对象」页：以列表展示表的行数、数据长度、引擎、创建/修改时间、排序规则、注释，可排序、搜索

**数据浏览与编辑**
- 分页浏览（100 / 500 / 1000 / 5000 条每页），点击表头服务端排序
- WHERE / ORDER BY 筛选，右键「筛选此值」
- 单元格内联编辑（双击、回车、直接输入）、设为 NULL / 空字符串、长文本 & JSON 编辑器
- 新增、删除记录，修改以颜色标记，统一「保存」（⌘S）在一个事务中提交；无主键表使用全部列定位
- ENUM / SET 列编辑时给出候选值；BIT、BLOB（十六进制）正确处理
- 复制单元格 / 行（TSV）/ INSERT 语句

**SQL 查询**
- CodeMirror 编辑器，MySQL 语法高亮、关键字 + 表名 + 列名自动补全
- 运行全部 / 选中部分（⌘↵）、运行当前语句（⇧⌘↵），支持 `DELIMITER`
- 多结果集分页签展示 + 「信息」页（受影响行数、耗时、错误）
- 停止正在执行的查询（`KILL QUERY`）
- 每个查询页独立会话：`USE`、会话变量、事务在多次执行间保持
- SQL 美化、查询历史、结果导出为 CSV / JSON / INSERT

**表设计器**
- 字段：名称、类型、NOT NULL、主键（含顺序）、自增、默认值、ON UPDATE、注释，插入 / 删除 / 上移 / 下移
- 索引（NORMAL / UNIQUE / FULLTEXT / SPATIAL、BTREE / HASH）、外键、表选项（引擎、字符集、排序规则、自增值、注释）
- 自动生成最小化的 `ALTER TABLE` / `CREATE TABLE`，可在「SQL 预览」中查看

**其他**
- 查看表 / 视图 / 过程 / 函数 / 触发器的 DDL，并可在查询编辑器中修改
- 新建 / 编辑数据库（字符集、排序规则）、删除数据库（需输入库名确认）
- 表：清空、删除、重命名、复制结构 / 结构和数据
- 导出表数据（CSV / JSON / SQL）、转储整个数据库为 SQL（结构 + 数据，含视图、过程、函数、触发器）、运行 SQL 文件
- 服务器监控：进程列表（自动刷新、结束进程）、状态、变量
- 跟随系统的浅色 / 深色主题

## 开发

需要 Node.js 18+、Rust 1.80+，以及 [Tauri 的系统依赖](https://tauri.app/start/prerequisites/)。

```bash
npm install
npm run tauri dev      # 启动桌面应用（开发模式）
npm run tauri build    # 打包发布版本
```

### 在浏览器中调试 UI

后端提供了一个仅用于开发的 HTTP 桥（`src-tauri/src/bin/web_bridge.rs`），让界面可以在普通浏览器中运行并连接真实的 MySQL：

```bash
npm run bridge         # 在 127.0.0.1:1430 启动后端桥
npm run dev            # 启动 Vite，然后打开 http://localhost:1420
```

浏览器模式下的连接配置保存在 `.dev-data/connections.json`，文件选择对话框会退化为输入路径。

### 测试

```bash
cd src-tauri && cargo test --lib   # SQL 语句拆分器单元测试
```

## 项目结构

```
src/                     前端 (React)
  api.ts                 Tauri invoke / 开发桥封装
  store.ts               全局状态 (zustand)：连接、对象树、标签页
  actions.ts             对象级操作（打开、设计、删除、重命名…）
  designer.ts            表设计器模型与 DDL 生成
  components/            对象树、数据表格、对话框、右键菜单
  tabs/                  查询、数据、设计、DDL、服务器监控、对象列表
src-tauri/src/           后端 (Rust)
  db.rs                  连接池、会话、元数据、查询执行、数据编辑
  transfer.rs            导出、转储、运行 SQL 文件
  sqlsplit.rs            SQL 语句拆分（引号、注释、DELIMITER）
  commands.rs            Tauri 命令
  bin/web_bridge.rs      开发用 HTTP 桥
```

## 已知限制

- 连接密码以明文保存在本机配置文件中（仅当前用户可读），尚未接入系统钥匙串
- 暂不支持 SSH 隧道、用户与权限管理、ER 图、数据同步 / 结构同步
- 查询结果最多返回 5000 行（超出部分会提示截断）；表数据通过分页浏览

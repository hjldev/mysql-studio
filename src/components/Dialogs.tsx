import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText, runSql } from "../api";
import { useStore, type ModalState } from "../store";
import type { Charset, ConnectionConfig, TaskSummary } from "../types";
import { toast } from "../ui";
import { formatMs, pickOpenPath, pickSavePath, qi, sqlString } from "../utils";
import { Modal } from "./Modal";

const COLORS = ["", "#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0090ff", "#8e4ec6", "#8b8d98"];

const emptyConfig = (): ConnectionConfig => ({
  id: "",
  name: "",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  database: "",
  ssl: false,
  sslAcceptInvalid: false,
  color: "",
});

export function ConnectionDialog() {
  const dlg = useStore((s) => s.connDialog);
  const [cfg, setCfg] = useState<ConnectionConfig>(emptyConfig);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (dlg) {
      setCfg({ ...emptyConfig(), ...(dlg.config ?? {}) });
      setTestResult(null);
    }
  }, [dlg]);

  if (!dlg) return null;
  const close = () => useStore.setState({ connDialog: null });
  const set = (patch: Partial<ConnectionConfig>) => setCfg((c) => ({ ...c, ...patch }));
  const normalized = (): ConnectionConfig => ({
    ...cfg,
    name: cfg.name.trim() || `${cfg.host}:${cfg.port}`,
    port: Number(cfg.port) || 3306,
    database: cfg.database?.trim() || null,
    color: cfg.color || null,
  });

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const v = await api.testConnection(normalized());
      setTestResult({ ok: true, text: `连接成功，服务器版本 ${v}` });
    } catch (e) {
      setTestResult({ ok: false, text: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    try {
      const saved = await useStore.getState().saveConnection(normalized());
      useStore.getState().select({ kind: "conn", connId: saved.id });
      close();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <Modal
      title={cfg.id ? "编辑连接" : "新建连接 - MySQL"}
      width={480}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={test} disabled={testing}>
            {testing && <Loader2 size={13} className="spin" />} 测试连接
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={close}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            确定
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>连接名</label>
        <input value={cfg.name} placeholder={`${cfg.host}:${cfg.port}`} autoFocus onChange={(e) => set({ name: e.target.value })} />
        <label>主机</label>
        <input value={cfg.host} onChange={(e) => set({ host: e.target.value })} />
        <label>端口</label>
        <input value={cfg.port} inputMode="numeric" onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
        <label>用户名</label>
        <input value={cfg.user} onChange={(e) => set({ user: e.target.value })} />
        <label>密码</label>
        <input type="password" value={cfg.password} onChange={(e) => set({ password: e.target.value })} />
        <label>默认数据库</label>
        <input value={cfg.database ?? ""} placeholder="可选" onChange={(e) => set({ database: e.target.value })} />
        <label>颜色</label>
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c || "none"}
              className={"swatch" + ((cfg.color || "") === c ? " on" : "")}
              style={{ background: c || "transparent" }}
              title={c || "无"}
              onClick={() => set({ color: c })}
            />
          ))}
        </div>
        <label>SSL</label>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={cfg.ssl} onChange={(e) => set({ ssl: e.target.checked })} /> 使用 SSL
          </label>
          <label className="check">
            <input
              type="checkbox"
              disabled={!cfg.ssl}
              checked={cfg.sslAcceptInvalid}
              onChange={(e) => set({ sslAcceptInvalid: e.target.checked })}
            />{" "}
            允许无效证书
          </label>
        </div>
      </div>
      {testResult && <div className={"test-result " + (testResult.ok ? "ok" : "err")}>{testResult.text}</div>}
    </Modal>
  );
}

export function TaskModals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  const close = () => useStore.setState({ modal: null });
  switch (modal.kind) {
    case "newDatabase":
    case "editDatabase":
      return <DatabaseDialog modal={modal} onClose={close} />;
    case "exportTable":
      return <ExportDialog modal={modal} onClose={close} />;
    case "dump":
      return <DumpDialog modal={modal} onClose={close} />;
    case "runFile":
      return <RunFileDialog modal={modal} onClose={close} />;
  }
}

function DatabaseDialog({
  modal,
  onClose,
}: {
  modal: Extract<ModalState, { kind: "newDatabase" | "editDatabase" }>;
  onClose: () => void;
}) {
  const editing = modal.kind === "editDatabase";
  const [name, setName] = useState(editing ? modal.db : "");
  const [charsets, setCharsets] = useState<Charset[]>([]);
  const [charset, setCharset] = useState("utf8mb4");
  const [collation, setCollation] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listCharsets(modal.connId).then(setCharsets).catch((e) => toast(errorText(e), "error"));
    if (editing) {
      runSql(
        modal.connId,
        `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${sqlString(modal.db)}`,
      )
        .then((r) => {
          const row = r[0]?.rows[0];
          if (row) {
            setCharset(String(row[0]));
            setCollation(String(row[1]));
          }
        })
        .catch(() => {});
    }
  }, [modal]);

  const cs = charsets.find((c) => c.name === charset);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const opts = `CHARACTER SET ${charset}` + (collation ? ` COLLATE ${collation}` : "");
    const sql = editing ? `ALTER DATABASE ${qi(name)} ${opts}` : `CREATE DATABASE ${qi(name.trim())} ${opts}`;
    try {
      await runSql(modal.connId, sql);
      toast(editing ? "数据库已修改" : `已创建数据库 ${name}`, "success");
      await useStore.getState().refreshDatabases(modal.connId);
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? "编辑数据库" : "新建数据库"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>
            确定
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>数据库名</label>
        <input value={name} disabled={editing} autoFocus onChange={(e) => setName(e.target.value)} />
        <label>字符集</label>
        <select
          value={charset}
          onChange={(e) => {
            setCharset(e.target.value);
            setCollation("");
          }}
        >
          {(charsets.length ? charsets.map((c) => c.name) : [charset]).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <label>排序规则</label>
        <select value={collation} onChange={(e) => setCollation(e.target.value)}>
          <option value="">默认{cs ? ` (${cs.defaultCollation})` : ""}</option>
          {cs?.collations.map((c) => <option key={c}>{c}</option>)}
          {collation && !cs?.collations.includes(collation) && <option>{collation}</option>}
        </select>
      </div>
    </Modal>
  );
}

function Summary({ s }: { s: TaskSummary }) {
  return (
    <div className="summary">
      <div>
        已执行 {s.statements} 条语句，影响/导出 {s.rows} 行，耗时 {formatMs(s.elapsedMs)}
      </div>
      {s.errors.length > 0 && (
        <>
          <div className="summary-err">{s.errors.length} 个错误：</div>
          <pre className="confirm-detail">{s.errors.join("\n\n")}</pre>
        </>
      )}
    </div>
  );
}

function ExportDialog({ modal, onClose }: { modal: Extract<ModalState, { kind: "exportTable" }>; onClose: () => void }) {
  const [format, setFormat] = useState("csv");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TaskSummary | null>(null);
  const ext = format === "sql" ? "sql" : format;

  const run = async () => {
    const path = await pickSavePath(`${modal.table}.${ext}`, [ext]);
    if (!path) return;
    setBusy(true);
    try {
      const r = await api.exportTable(modal.connId, modal.db, modal.table, format, path, filter);
      setResult(r);
      toast(`已导出 ${r.rows} 行到 ${path}`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`导出 ${modal.db}.${modal.table}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" disabled={busy} onClick={run}>
            {busy && <Loader2 size={13} className="spin" />} 导出…
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>格式</label>
        <div className="checks">
          {[
            ["csv", "CSV"],
            ["json", "JSON"],
            ["sql", "SQL (INSERT)"],
          ].map(([v, l]) => (
            <label key={v} className="check">
              <input type="radio" checked={format === v} onChange={() => setFormat(v)} /> {l}
            </label>
          ))}
        </div>
        <label>筛选条件</label>
        <input value={filter} placeholder="WHERE 子句（可选），例如 id > 100" onChange={(e) => setFilter(e.target.value)} />
      </div>
      {result && <Summary s={result} />}
    </Modal>
  );
}

function DumpDialog({ modal, onClose }: { modal: Extract<ModalState, { kind: "dump" }>; onClose: () => void }) {
  const [withData, setWithData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TaskSummary | null>(null);

  const run = async () => {
    const path = await pickSavePath(`${modal.db}.sql`, ["sql"]);
    if (!path) return;
    setBusy(true);
    try {
      const r = await api.dumpDatabase(modal.connId, modal.db, path, withData);
      setResult(r);
      toast(`已转储到 ${path}`, r.errors.length ? "error" : "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`转储 SQL 文件 - ${modal.db}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" disabled={busy} onClick={run}>
            {busy && <Loader2 size={13} className="spin" />} 开始转储…
          </button>
        </>
      }
    >
      <div className="checks vertical">
        <label className="check">
          <input type="radio" checked={withData} onChange={() => setWithData(true)} /> 结构和数据
        </label>
        <label className="check">
          <input type="radio" checked={!withData} onChange={() => setWithData(false)} /> 仅结构
        </label>
      </div>
      <p className="hint">包含表、视图、存储过程、函数和触发器。</p>
      {result && <Summary s={result} />}
    </Modal>
  );
}

function RunFileDialog({ modal, onClose }: { modal: Extract<ModalState, { kind: "runFile" }>; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [coe, setCoe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TaskSummary | null>(null);

  const choose = async () => {
    const p = await pickOpenPath(["sql", "txt"]);
    if (p) setPath(p);
  };

  const run = async () => {
    if (!path) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.runSqlFile(modal.connId, modal.db, path, coe);
      setResult(r);
      toast(r.errors.length ? `执行完成，有 ${r.errors.length} 个错误` : "SQL 文件执行完成", r.errors.length ? "error" : "success");
      const s = useStore.getState();
      await s.refreshDatabases(modal.connId);
      if (modal.db) await s.loadObjects(modal.connId, modal.db, true);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="运行 SQL 文件"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" disabled={busy || !path} onClick={run}>
            {busy && <Loader2 size={13} className="spin" />} 开始
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>数据库</label>
        <input value={modal.db ?? "(无)"} disabled />
        <label>文件</label>
        <div className="row-input">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="选择 .sql 文件" />
          <button className="btn" onClick={choose}>
            浏览…
          </button>
        </div>
        <label />
        <label className="check">
          <input type="checkbox" checked={coe} onChange={(e) => setCoe(e.target.checked)} /> 遇到错误继续
        </label>
      </div>
      {result && <Summary s={result} />}
    </Modal>
  );
}

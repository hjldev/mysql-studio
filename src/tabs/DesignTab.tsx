import { ArrowDown, ArrowUp, KeyRound, ListPlus, Loader2, Minus, Plus, RefreshCw, Save, TableProperties } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openTable } from "../actions";
import { api, errorText, runSql } from "../api";
import {
  buildAlter,
  buildCreate,
  COMMON_TYPES,
  emptyModel,
  ENGINES,
  FK_RULES,
  modelFromStructure,
  newFk,
  newField,
  newIndex,
  validate,
  type FieldRow,
  type FkRow,
  type IndexRow,
  type TableModel,
} from "../designer";
import { useHotkey } from "../hooks";
import { objKey, useStore } from "../store";
import type { Charset, Tab } from "../types";
import { askText, toast } from "../ui";

type DesignTabT = Extract<Tab, { kind: "design" }>;
type Sub = "fields" | "indexes" | "fks" | "options" | "sql";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export function DesignTab({ tab, active }: { tab: DesignTabT; active: boolean }) {
  const [orig, setOrig] = useState<TableModel | null>(null);
  const [model, setModel] = useState<TableModel | null>(null);
  const [sub, setSub] = useState<Sub>("fields");
  const [sel, setSel] = useState(0);
  const [selIdx, setSelIdx] = useState(0);
  const [selFk, setSelFk] = useState(0);
  const [charsets, setCharsets] = useState<Charset[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tables = useStore((s) => s.objects[objKey(tab.connId, tab.db)]?.tables ?? []);
  const saveRef = useRef<() => void>(() => {});
  const onSaveKey = useCallback(() => saveRef.current(), []);
  useHotkey("s", onSaveKey, active);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tab.table) {
        const st = await api.tableStructure(tab.connId, tab.db, tab.table);
        const m = modelFromStructure(st);
        setOrig(m);
        setModel(clone(m));
      } else {
        const m = emptyModel();
        setOrig(null);
        setModel(m);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, [tab.connId, tab.db, tab.table]);

  useEffect(() => {
    load();
    api.listCharsets(tab.connId).then(setCharsets).catch(() => {});
  }, [load, tab.connId]);

  const statements = useMemo(() => {
    if (!model) return [];
    if (!tab.table) return buildCreate(tab.db, "<新表>", model);
    return orig ? buildAlter(tab.db, tab.table, orig, model) : [];
  }, [model, orig, tab.db, tab.table]);

  const dirty = !tab.table ? true : statements.length > 0;
  useEffect(() => useStore.getState().setDirty(tab.id, dirty && !!model), [dirty, model, tab.id]);

  if (error) return <div className="error-box">{error}</div>;
  if (!model) {
    return (
      <div className="empty-hint">
        <Loader2 size={16} className="spin" /> 加载中…
      </div>
    );
  }

  const update = (fn: (m: TableModel) => void) =>
    setModel((m) => {
      const next = clone(m!);
      fn(next);
      return next;
    });
  const setField = (i: number, patch: Partial<FieldRow>) => update((m) => Object.assign(m.fields[i], patch));
  const setIndex = (i: number, patch: Partial<IndexRow>) => update((m) => Object.assign(m.indexes[i], patch));
  const setFkRow = (i: number, patch: Partial<FkRow>) => update((m) => Object.assign(m.fks[i], patch));

  const save = async () => {
    if (saving || !model) return;
    const err = validate(model);
    if (err) return toast(err, "error");
    let name = tab.table;
    let stmts = statements;
    if (!name) {
      name = (await askText({ title: "保存新表", label: "表名", value: "" }))?.trim() || null;
      if (!name) return;
      stmts = buildCreate(tab.db, name, model);
    }
    if (!stmts.length) return toast("没有需要保存的更改");
    setSaving(true);
    try {
      for (const s of stmts) await runSql(tab.connId, s, tab.db);
      toast(tab.table ? "表结构已保存" : `已创建表 ${name}`, "success");
      const s = useStore.getState();
      s.loadObjects(tab.connId, tab.db, true);
      if (!tab.table) {
        s.updateTab(tab.id, { table: name, title: `${name} @${tab.db} (设计)` });
      } else {
        await load();
      }
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  };

  saveRef.current = save;

  const fieldNames = model.fields.map((f) => f.name).filter(Boolean);
  const cs = charsets.find((c) => c.name === model.options.charset);

  return (
    <div className="design-tab">
      <div className="toolbar small">
        <button className="tbtn" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存
        </button>
        <span className="tsep" />
        {sub === "fields" && (
          <>
            <button
              className="tbtn"
              onClick={() => {
                update((m) => m.fields.push(newField()));
                setSel(model.fields.length);
              }}
            >
              <Plus size={14} /> 添加字段
            </button>
            <button
              className="tbtn"
              onClick={() => {
                update((m) => m.fields.splice(sel, 0, newField()));
              }}
            >
              <ListPlus size={14} /> 插入字段
            </button>
            <button
              className="tbtn"
              disabled={!model.fields.length}
              onClick={() => {
                update((m) => m.fields.splice(sel, 1));
                setSel((s) => Math.max(0, Math.min(s, model.fields.length - 2)));
              }}
            >
              <Minus size={14} /> 删除字段
            </button>
            <button className="tbtn" disabled={!model.fields[sel]} onClick={() => setField(sel, { pk: !model.fields[sel].pk, notNull: true })}>
              <KeyRound size={14} /> 主键
            </button>
            <button
              className="tbtn"
              disabled={sel === 0}
              onClick={() => {
                update((m) => m.fields.splice(sel - 1, 0, ...m.fields.splice(sel, 1)));
                setSel(sel - 1);
              }}
            >
              <ArrowUp size={14} /> 上移
            </button>
            <button
              className="tbtn"
              disabled={sel >= model.fields.length - 1}
              onClick={() => {
                update((m) => m.fields.splice(sel + 1, 0, ...m.fields.splice(sel, 1)));
                setSel(sel + 1);
              }}
            >
              <ArrowDown size={14} /> 下移
            </button>
          </>
        )}
        {sub === "indexes" && (
          <>
            <button
              className="tbtn"
              onClick={() => {
                update((m) => m.indexes.push(newIndex()));
                setSelIdx(model.indexes.length);
              }}
            >
              <Plus size={14} /> 添加索引
            </button>
            <button className="tbtn" disabled={!model.indexes.length} onClick={() => update((m) => m.indexes.splice(selIdx, 1))}>
              <Minus size={14} /> 删除索引
            </button>
          </>
        )}
        {sub === "fks" && (
          <>
            <button
              className="tbtn"
              onClick={() => {
                update((m) => m.fks.push(newFk(tab.db)));
                setSelFk(model.fks.length);
              }}
            >
              <Plus size={14} /> 添加外键
            </button>
            <button className="tbtn" disabled={!model.fks.length} onClick={() => update((m) => m.fks.splice(selFk, 1))}>
              <Minus size={14} /> 删除外键
            </button>
          </>
        )}
        <span className="tsep" />
        <button className="tbtn" onClick={load} disabled={!tab.table} title="放弃更改并重新加载">
          <RefreshCw size={14} /> 重新加载
        </button>
        {tab.table && (
          <button className="tbtn" onClick={() => openTable(tab.connId, tab.db, tab.table!)}>
            <TableProperties size={14} /> 打开表
          </button>
        )}
        <span className="tspacer" />
        {tab.table && dirty && <span className="dirty-badge">未保存</span>}
      </div>
      <div className="subtabs">
        {(
          [
            ["fields", `字段 (${model.fields.length})`],
            ["indexes", `索引 (${model.indexes.length})`],
            ["fks", `外键 (${model.fks.length})`],
            ["options", "选项"],
            ["sql", `SQL 预览${statements.length && tab.table ? ` (${statements.length})` : ""}`],
          ] as [Sub, string][]
        ).map(([k, l]) => (
          <button key={k} className={sub === k ? "on" : ""} onClick={() => setSub(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="design-body">
        <datalist id="type-list">
          {COMMON_TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {sub === "fields" && (
          <table className="design-table">
            <thead>
              <tr>
                <th style={{ width: 22 }} />
                <th>名</th>
                <th>类型</th>
                <th title="NOT NULL">不是 null</th>
                <th>键</th>
                <th>自动递增</th>
                <th>默认值</th>
                <th>更新时</th>
                <th>注释</th>
              </tr>
            </thead>
            <tbody>
              {model.fields.map((f, i) => (
                <tr key={f.uid} className={(i === sel ? "sel" : "") + (f.orig ? "" : " new")} onMouseDown={() => setSel(i)}>
                  <td className="mark">{i === sel ? "▶" : ""}</td>
                  <td>
                    <input value={f.name} onChange={(e) => setField(i, { name: e.target.value })} autoFocus={!f.name && i === sel} />
                  </td>
                  <td>
                    <input value={f.type} list="type-list" onChange={(e) => setField(i, { type: e.target.value })} />
                  </td>
                  <td className="center">
                    <input type="checkbox" checked={f.notNull} onChange={(e) => setField(i, { notNull: e.target.checked })} />
                  </td>
                  <td className="center">
                    <button
                      className={"key-toggle" + (f.pk ? " on" : "")}
                      title="主键"
                      onClick={() => setField(i, { pk: !f.pk, notNull: f.pk ? f.notNull : true })}
                    >
                      <KeyRound size={12} />
                      {f.pk ? model.fields.filter((x) => x.pk).indexOf(f) + 1 : ""}
                    </button>
                  </td>
                  <td className="center">
                    <input type="checkbox" checked={f.autoInc} onChange={(e) => setField(i, { autoInc: e.target.checked })} />
                  </td>
                  <td>
                    <input
                      value={f.generated ? `AS (${f.generated})` : f.defaultValue}
                      disabled={!!f.generated}
                      placeholder={f.autoInc ? "" : "无"}
                      list="default-list"
                      onChange={(e) => setField(i, { defaultValue: e.target.value })}
                    />
                  </td>
                  <td>
                    <input value={f.onUpdate} placeholder="" list="onupdate-list" onChange={(e) => setField(i, { onUpdate: e.target.value })} />
                  </td>
                  <td>
                    <input value={f.comment} onChange={(e) => setField(i, { comment: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <datalist id="default-list">
          <option value="NULL" />
          <option value="CURRENT_TIMESTAMP" />
          <option value="''" />
          <option value="0" />
        </datalist>
        <datalist id="onupdate-list">
          <option value="CURRENT_TIMESTAMP" />
        </datalist>
        <datalist id="field-list">
          {fieldNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {sub === "indexes" && (
          <table className="design-table">
            <thead>
              <tr>
                <th style={{ width: 22 }} />
                <th>名</th>
                <th>字段（逗号分隔，可写前缀长度如 name(10)）</th>
                <th>索引类型</th>
                <th>索引方法</th>
                <th>注释</th>
              </tr>
            </thead>
            <tbody>
              {model.indexes.map((x, i) => (
                <tr key={x.uid} className={i === selIdx ? "sel" : ""} onMouseDown={() => setSelIdx(i)}>
                  <td className="mark">{i === selIdx ? "▶" : ""}</td>
                  <td>
                    <input value={x.name} onChange={(e) => setIndex(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <input value={x.columns} list="field-list" onChange={(e) => setIndex(i, { columns: e.target.value })} />
                  </td>
                  <td>
                    <select value={x.kind} onChange={(e) => setIndex(i, { kind: e.target.value as IndexRow["kind"] })}>
                      <option value="NORMAL">NORMAL</option>
                      <option value="UNIQUE">UNIQUE</option>
                      <option value="FULLTEXT">FULLTEXT</option>
                      <option value="SPATIAL">SPATIAL</option>
                    </select>
                  </td>
                  <td>
                    <select value={x.method} onChange={(e) => setIndex(i, { method: e.target.value as IndexRow["method"] })}>
                      <option value="">(默认)</option>
                      <option value="BTREE">BTREE</option>
                      <option value="HASH">HASH</option>
                    </select>
                  </td>
                  <td>
                    <input value={x.comment} onChange={(e) => setIndex(i, { comment: e.target.value })} />
                  </td>
                </tr>
              ))}
              {model.indexes.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-row">
                    没有索引（主键请在「字段」中设置）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {sub === "fks" && (
          <table className="design-table">
            <thead>
              <tr>
                <th style={{ width: 22 }} />
                <th>名</th>
                <th>字段</th>
                <th>被引用的库</th>
                <th>被引用的表</th>
                <th>被引用的字段</th>
                <th>删除时</th>
                <th>更新时</th>
              </tr>
            </thead>
            <tbody>
              <datalist id="table-list">
                {tables.map((t) => (
                  <option key={t.name} value={t.name} />
                ))}
              </datalist>
              {model.fks.map((x, i) => (
                <tr key={x.uid} className={i === selFk ? "sel" : ""} onMouseDown={() => setSelFk(i)}>
                  <td className="mark">{i === selFk ? "▶" : ""}</td>
                  <td>
                    <input value={x.name} onChange={(e) => setFkRow(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <input value={x.columns} list="field-list" onChange={(e) => setFkRow(i, { columns: e.target.value })} />
                  </td>
                  <td>
                    <input value={x.refSchema} onChange={(e) => setFkRow(i, { refSchema: e.target.value })} />
                  </td>
                  <td>
                    <input value={x.refTable} list="table-list" onChange={(e) => setFkRow(i, { refTable: e.target.value })} />
                  </td>
                  <td>
                    <input value={x.refColumns} onChange={(e) => setFkRow(i, { refColumns: e.target.value })} />
                  </td>
                  <td>
                    <select value={x.onDelete} onChange={(e) => setFkRow(i, { onDelete: e.target.value })}>
                      {FK_RULES.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={x.onUpdate} onChange={(e) => setFkRow(i, { onUpdate: e.target.value })}>
                      {FK_RULES.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {model.fks.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty-row">
                    没有外键
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {sub === "options" && (
          <div className="form-grid options-form">
            <label>引擎</label>
            <select value={model.options.engine} onChange={(e) => update((m) => void (m.options.engine = e.target.value))}>
              {[...new Set([model.options.engine, ...ENGINES])].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <label>字符集</label>
            <select
              value={model.options.charset}
              onChange={(e) =>
                update((m) => {
                  m.options.charset = e.target.value;
                  m.options.collation = "";
                })
              }
            >
              {[...new Set([model.options.charset, ...charsets.map((c) => c.name)])].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <label>排序规则</label>
            <select value={model.options.collation} onChange={(e) => update((m) => void (m.options.collation = e.target.value))}>
              <option value="">默认{cs ? ` (${cs.defaultCollation})` : ""}</option>
              {[...new Set([...(model.options.collation ? [model.options.collation] : []), ...(cs?.collations ?? [])])].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <label>自动递增</label>
            <input value={model.options.autoIncrement} onChange={(e) => update((m) => void (m.options.autoIncrement = e.target.value.replace(/\D/g, "")))} />
            <label>注释</label>
            <textarea rows={4} value={model.options.comment} onChange={(e) => update((m) => void (m.options.comment = e.target.value))} />
          </div>
        )}
        {sub === "sql" && (
          <pre className="sql-preview-box">
            {statements.length ? statements.map((s) => s + ";").join("\n\n") : "-- 没有更改"}
          </pre>
        )}
      </div>
    </div>
  );
}

import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useUi } from "../ui";

const openModals: symbol[] = [];

export function Modal({
  title,
  width = 460,
  onClose,
  footer,
  children,
}: {
  title: ReactNode;
  width?: number;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const id = Symbol();
    openModals.push(id);
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost modal reacts to Escape.
      if (e.key === "Escape" && openModals[openModals.length - 1] === id) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      openModals.splice(openModals.indexOf(id), 1);
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog">
        <div className="modal-header">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Renders confirm/prompt requests and toasts from the ui store. */
export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const toasts = useUi((s) => s.toasts);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (dialog?.kind === "prompt") setValue(dialog.value ?? "");
  }, [dialog]);

  return (
    <>
      {dialog?.kind === "confirm" && (
        <Modal
          title={dialog.title}
          width={420}
          onClose={() => dialog.resolve(false)}
          footer={
            <>
              <button className="btn" onClick={() => dialog.resolve(false)}>
                取消
              </button>
              <button className={"btn " + (dialog.danger ? "danger" : "primary")} autoFocus onClick={() => dialog.resolve(true)}>
                {dialog.okText ?? "确定"}
              </button>
            </>
          }
        >
          <p className="confirm-text">{dialog.message}</p>
          {dialog.detail && <pre className="confirm-detail">{dialog.detail}</pre>}
        </Modal>
      )}
      {dialog?.kind === "prompt" && (
        <Modal
          title={dialog.title}
          width={440}
          onClose={() => dialog.resolve(null)}
          footer={
            <>
              <button className="btn" onClick={() => dialog.resolve(null)}>
                取消
              </button>
              <button className="btn primary" onClick={() => dialog.resolve(value)}>
                确定
              </button>
            </>
          }
        >
          <label className="field">
            <span>{dialog.label}</span>
            {dialog.multiline ? (
              <textarea autoFocus rows={6} value={value} onChange={(e) => setValue(e.target.value)} />
            ) : (
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && dialog.resolve(value)}
              />
            )}
          </label>
        </Modal>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}

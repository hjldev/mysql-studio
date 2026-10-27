import { create } from "zustand";

/** Promise-based confirm/prompt dialogs and toasts, rendered by <DialogHost/>. */

export interface ConfirmRequest {
  kind: "confirm";
  title: string;
  message: string;
  okText?: string;
  danger?: boolean;
  detail?: string;
  resolve: (ok: boolean) => void;
}

export interface PromptRequest {
  kind: "prompt";
  title: string;
  label: string;
  value?: string;
  multiline?: boolean;
  resolve: (v: string | null) => void;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

interface UiState {
  dialog: ConfirmRequest | PromptRequest | null;
  toasts: Toast[];
}

export const useUi = create<UiState>(() => ({ dialog: null, toasts: [] }));

export function confirmDialog(opts: Omit<ConfirmRequest, "kind" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    useUi.setState({
      dialog: {
        kind: "confirm",
        ...opts,
        resolve: (v) => {
          useUi.setState({ dialog: null });
          resolve(v);
        },
      },
    });
  });
}

export function askText(opts: Omit<PromptRequest, "kind" | "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    useUi.setState({
      dialog: {
        kind: "prompt",
        ...opts,
        resolve: (v) => {
          useUi.setState({ dialog: null });
          resolve(v);
        },
      },
    });
  });
}

let toastSeq = 0;

export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = ++toastSeq;
  useUi.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(
    () => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    kind === "error" ? 8000 : 3500,
  );
}

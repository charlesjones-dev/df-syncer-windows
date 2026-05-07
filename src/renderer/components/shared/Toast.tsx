import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Toast — a small bottom-right notifier with `success`/`error`/`info`
 * variants, auto-dismiss after 4 s, and a manual dismiss button.
 *
 * The hook `useToasts()` is the public surface. It returns:
 *  - `toasts`: the array currently visible (capped at 3, newest last)
 *  - `push(variant, message)`: enqueue a new toast
 *  - `dismiss(id)`: imperatively remove one
 *
 * The `<ToastStack />` component renders the array. Co-locate it once
 * at the top level of the dashboard; child components push via the
 * hook + a context provider if they need to (Phase 9 keeps it simple
 * and threads the `push` callback through props).
 */

export type ToastVariant = 'success' | 'error' | 'info';

export type ToastEntry = {
  id: string;
  variant: ToastVariant;
  message: string;
};

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 4000;

export type UseToasts = {
  toasts: readonly ToastEntry[];
  push: (variant: ToastVariant, message: string) => string;
  dismiss: (id: string) => void;
};

let counter = 0;
function nextId(): string {
  counter += 1;
  return `t-${counter}`;
}

export function useToasts(): UseToasts {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string): void => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string): string => {
      const id = nextId();
      setToasts((prev) => {
        const next = [...prev, { id, variant, message }];
        // Drop oldest if we exceed the visible cap.
        while (next.length > MAX_VISIBLE) {
          const dropped = next.shift();
          if (dropped) {
            const t = timersRef.current.get(dropped.id);
            if (t) {
              clearTimeout(t);
              timersRef.current.delete(dropped.id);
            }
          }
        }
        return next;
      });
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
      return id;
    },
    [dismiss]
  );

  // Clear timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

export type ToastStackProps = {
  toasts: readonly ToastEntry[];
  onDismiss: (id: string) => void;
};

export function ToastStack(props: ToastStackProps): JSX.Element | null {
  if (props.toasts.length === 0) return null;
  return (
    <div
      className="toast-stack"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      data-testid="toast-stack"
    >
      {props.toasts.map((t) => (
        <Toast key={t.id} entry={t} onDismiss={() => props.onDismiss(t.id)} />
      ))}
    </div>
  );
}

type ToastProps = {
  entry: ToastEntry;
  onDismiss: () => void;
};

function Toast(props: ToastProps): JSX.Element {
  const { entry } = props;
  return (
    <div
      role={entry.variant === 'error' ? 'alert' : 'status'}
      className={`toast toast--${entry.variant}`}
      data-testid={`toast-${entry.variant}`}
    >
      <span className="toast__icon" aria-hidden="true">
        {entry.variant === 'success' ? '✓' : entry.variant === 'error' ? '✗' : 'i'}
      </span>
      <span className="toast__msg">{entry.message}</span>
      <button
        type="button"
        className="toast__close"
        aria-label="Dismiss notification"
        onClick={props.onDismiss}
      >
        ×
      </button>
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';

export interface ModalProps {
  /** Names the dialog for assistive tech, and is its visible heading. */
  title: string;
  description?: string;
  onClose: () => void;
  /** Buttons along the bottom; the form's submit usually lives here. */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The dialog every "new …" and "edit …" form opens in.
 *
 * Three things make it a dialog rather than a floating div: it is labelled
 * by its own heading, Escape closes it, and focus moves into it when it
 * opens — otherwise a keyboard user's focus stays behind on the button
 * that opened it, and their next Tab walks the page underneath.
 *
 * Closing is deliberately the caller's decision (`onClose`) rather than
 * internal state, because a submit that failed must be able to keep the
 * dialog open with the server's message still in it.
 */
export function Modal({ title, description, onClose, footer, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The panel itself takes focus rather than the first input: an autofocused
    // field would scroll a long form to the middle and skip the heading that
    // says what the form is for.
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      // Without this, Tab/Shift+Tab eventually walks off the panel and onto
      // whatever's behind it — the same page-underneath leak the initial
      // focus move above exists to avoid, just reachable a key press later
      // instead of immediately on open.
      if (event.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) {
          return;
        }

        const focusable = panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) {
          // Nothing inside to tab to — keep focus pinned on the panel
          // itself rather than letting it escape to the page underneath.
          event.preventDefault();
          return;
        }

        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;

        // `active === panel` covers Shift+Tab pressed right after opening,
        // before focus has moved off the panel itself onto any child — the
        // moment the initial-focus effect above hands off to this trap.
        if (event.shiftKey && (active === first || active === panel)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      {/*
        The backdrop closes the dialog on click. It is a plain div with an
        aria-hidden label rather than a button because it is a convenience
        duplicate of the Cancel button in the footer, which is what a
        keyboard user reaches.
      */}
      <div className="absolute inset-0" aria-hidden="true" onClick={onClose} />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative z-10 w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-xl focus:outline-none"
      >
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
        </div>

        <div className="px-5 py-4">{children}</div>

        {footer ? (
          <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

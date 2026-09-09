import { useEffect, useRef, type RefObject } from "react";

const dialogs: HTMLElement[] = [];
const inertOwners = new Map<HTMLElement, { count: number; original: boolean }>();

export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled = true) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !enabled) return;
    const previous = document.activeElement;
    dialogs.push(dialog);
    const hidden: HTMLElement[] = [];
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          const owner = inertOwners.get(sibling) ?? { count: 0, original: sibling.inert };
          owner.count += 1; inertOwners.set(sibling, owner);
          hidden.push(sibling); sibling.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'));
    (dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusable()[0] ?? dialog).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || dialogs.at(-1) !== dialog) return;
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0] ?? dialog;
      const last = elements.at(-1) ?? dialog;
      if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (dialogs.at(-1) === dialog && event.target instanceof Node && !dialog.contains(event.target)) (focusable()[0] ?? dialog).focus();
    };
    document.addEventListener("focusin", containFocus);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", containFocus);
      dialogs.splice(dialogs.lastIndexOf(dialog), 1);
      hidden.reverse().forEach((element) => {
        const owner = inertOwners.get(element);
        if (owner && --owner.count === 0) { element.inert = owner.original; inertOwners.delete(element); }
      });
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous.isConnected && !previous.closest("[inert]")) previous.focus();
        else dialogs.at(-1)?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')?.focus();
      });
    };
  }, [ref, enabled]);
}

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardPaste } from 'lucide-react';
import {
  readSystemClipboardText,
  subscribeNativeInputLongPress,
} from '../utils/readerNative';

type EditableInputElement = HTMLInputElement | HTMLTextAreaElement;

interface PastePopoverState {
  target: EditableInputElement;
  left: number;
  top: number;
  placement: 'above' | 'below';
  openedAt: number;
  openedCaret: number | null;
  anchorInputTop: number;
  anchorInputLeft: number;
}

interface InputPastePopoverProps {
  onFeedback?: (msg: string) => void;
}

const ALLOWED_INPUT_TYPES = new Set([
  'text',
  'password',
  'url',
  'email',
  'search',
  'tel',
  'number',
]);

const LONG_PRESS_MS = 380;
const MOVE_CANCEL_PX = 24;
const POPOVER_HALF_WIDTH = 52;
const POPOVER_EDGE_MARGIN = 12;
const POPOVER_GAP_PX = 10;
const TOP_FLIP_THRESHOLD = 56;
const POST_OPEN_SELECTION_GUARD_MS = 450;

const MIRROR_STYLE_PROPS = [
  'direction',
  'boxSizing',
  'width',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
] as const;

function isEditableInput(node: EventTarget | null): node is EditableInputElement {
  if (!(node instanceof HTMLElement)) return false;
  if (node instanceof HTMLTextAreaElement) {
    return !node.disabled && !node.readOnly;
  }
  if (node instanceof HTMLInputElement) {
    if (node.disabled || node.readOnly) return false;
    const type = (node.getAttribute('type') || 'text').toLowerCase();
    return ALLOWED_INPUT_TYPES.has(type);
  }
  return false;
}

function resolveEditableTarget(node: EventTarget | null): EditableInputElement | null {
  if (isEditableInput(node)) return node;
  if (node instanceof Element) {
    const label = node.closest('label');
    if (label && isEditableInput(label.control)) {
      return label.control;
    }
  }
  return null;
}

function getCaretIndex(el: EditableInputElement): number | null {
  try {
    return typeof el.selectionStart === 'number' ? el.selectionStart : null;
  } catch {
    return null;
  }
}

function isCollapsedSelection(el: EditableInputElement): boolean {
  try {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === null && end === null) return true;
    return start === end;
  } catch {
    return true;
  }
}

function isActiveWithCollapsedCaret(el: EditableInputElement): boolean {
  return el.isConnected && document.activeElement === el && isCollapsedSelection(el);
}

function isPointNearInput(el: EditableInputElement, x: number, y: number): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  // Allow extra bottom margin for Android's native teardrop insertion handle below the cursor
  return (
    x >= rect.left - 24 &&
    x <= rect.right + 24 &&
    y >= rect.top - 24 &&
    y <= rect.bottom + 48
  );
}

function getCaretViewportRect(
  el: EditableInputElement
): { x: number; top: number; bottom: number } | null {
  if (el instanceof HTMLInputElement && (el.type || '').toLowerCase() === 'password') {
    return null;
  }
  const caretIndex = getCaretIndex(el);
  if (caretIndex === null) return null;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const style = window.getComputedStyle(el);
  const mirror = document.createElement('div');
  mirror.style.position = 'fixed';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';

  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style[prop] = style[prop];
  }

  if (el instanceof HTMLTextAreaElement) {
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
  } else {
    mirror.style.whiteSpace = 'pre';
    mirror.style.overflowWrap = 'normal';
  }

  mirror.textContent = el.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  try {
    const x = rect.left + marker.offsetLeft - el.scrollLeft;
    const fontSize = parseFloat(style.fontSize) || 14;
    const rawLineHeight = parseFloat(style.lineHeight);
    const lineHeight = Number.isFinite(rawLineHeight) ? rawLineHeight : Math.round(fontSize * 1.4);

    if (el instanceof HTMLInputElement) {
      const clampedX = Math.max(rect.left + 8, Math.min(rect.right - 8, x));
      return {
        x: clampedX,
        top: rect.top,
        bottom: rect.bottom,
      };
    }

    const top = rect.top + marker.offsetTop - el.scrollTop;
    const bottom = top + Math.max(marker.offsetHeight, lineHeight);
    if (bottom < rect.top - 8 || top > rect.bottom + 8) {
      return null;
    }
    return {
      x: Math.max(rect.left + 8, Math.min(rect.right - 8, x)),
      top: Math.max(rect.top, top),
      bottom: Math.min(rect.bottom, bottom),
    };
  } finally {
    document.body.removeChild(mirror);
  }
}

function computePopoverPosition(
  el: EditableInputElement,
  fallbackX?: number,
  fallbackY?: number
): PastePopoverState {
  const inputRect = el.getBoundingClientRect();
  const caretRect = getCaretViewportRect(el);

  const defaultX =
    typeof fallbackX === 'number' && Number.isFinite(fallbackX)
      ? Math.max(inputRect.left + 8, Math.min(inputRect.right - 8, fallbackX))
      : inputRect.left + Math.min(24, inputRect.width / 2);
  const defaultY =
    typeof fallbackY === 'number' && Number.isFinite(fallbackY)
      ? fallbackY
      : inputRect.top + inputRect.height / 2;

  const anchorX = caretRect ? caretRect.x : defaultX;
  const anchorTop = caretRect
    ? caretRect.top
    : el instanceof HTMLTextAreaElement
      ? Math.max(inputRect.top, Math.min(inputRect.bottom, defaultY - 12))
      : inputRect.top;
  const anchorBottom = caretRect
    ? caretRect.bottom
    : el instanceof HTMLTextAreaElement
      ? Math.max(inputRect.top, Math.min(inputRect.bottom, defaultY + 12))
      : inputRect.bottom;

  const minLeft = POPOVER_HALF_WIDTH + POPOVER_EDGE_MARGIN;
  const maxLeft = Math.max(minLeft, window.innerWidth - POPOVER_HALF_WIDTH - POPOVER_EDGE_MARGIN);
  const clampedLeft = Math.max(minLeft, Math.min(maxLeft, anchorX));

  const openedAt = performance.now();
  const openedCaret = getCaretIndex(el);

  if (anchorTop >= TOP_FLIP_THRESHOLD) {
    return {
      target: el,
      left: clampedLeft,
      top: Math.max(8, anchorTop - POPOVER_GAP_PX),
      placement: 'above',
      openedAt,
      openedCaret,
      anchorInputTop: inputRect.top,
      anchorInputLeft: inputRect.left,
    };
  }

  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  return {
    target: el,
    left: clampedLeft,
    top: Math.min(viewportHeight - 48, anchorBottom + POPOVER_GAP_PX),
    placement: 'below',
    openedAt,
    openedCaret,
    anchorInputTop: inputRect.top,
    anchorInputLeft: inputRect.left,
  };
}

function insertTextAtCaret(
  el: EditableInputElement,
  rawText: string,
  fallbackCaret: number | null
): boolean {
  if (!el.isConnected || el.disabled || el.readOnly) return false;

  const normalized =
    el instanceof HTMLTextAreaElement
      ? rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      : rawText.replace(/[\r\n]/g, '');

  const currentValue = el.value;
  let start = fallbackCaret !== null ? Math.min(fallbackCaret, currentValue.length) : currentValue.length;
  let end = start;
  try {
    if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
      start = el.selectionStart;
      end = el.selectionEnd;
    }
  } catch {
    // keep fallback
  }

  let insertText = normalized;
  if (typeof el.maxLength === 'number' && el.maxLength >= 0) {
    const remaining = Math.max(0, el.maxLength - (currentValue.length - (end - start)));
    insertText = insertText.slice(0, remaining);
  }

  const nextValue = currentValue.slice(0, start) + insertText + currentValue.slice(end);
  const nextCaret = start + insertText.length;

  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(el, nextValue);
  } else {
    el.value = nextValue;
  }

  try {
    el.setSelectionRange(nextCaret, nextCaret);
  } catch {
    // Some input types (e.g. number) do not support setSelectionRange
  }

  let inputEvent: Event;
  try {
    inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertFromPaste',
      data: insertText,
    });
  } catch {
    inputEvent = new Event('input', { bubbles: true, cancelable: true });
  }
  el.dispatchEvent(inputEvent);

  window.requestAnimationFrame(() => {
    if (!el.isConnected) return;
    if (document.activeElement !== el) {
      el.focus({ preventScroll: true });
    }
    try {
      el.setSelectionRange(nextCaret, nextCaret);
    } catch {
      // Ignore input types that do not support setSelectionRange
    }
  });

  return true;
}

export const InputPastePopover: React.FC<InputPastePopoverProps> = ({ onFeedback }) => {
  const [popover, setPopover] = useState<PastePopoverState | null>(null);
  const popoverRef = useRef<PastePopoverState | null>(null);
  const onFeedbackRef = useRef(onFeedback);
  const lastPasteTriggerAtRef = useRef<number>(0);

  const pressTimerRef = useRef<number | null>(null);
  const pressTargetRef = useRef<EditableInputElement | null>(null);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const pressStartedAtRef = useRef<number>(0);
  const pressPointerIdRef = useRef<number | null>(null);
  const lastNonMouseDownAtRef = useRef<number>(0);

  useEffect(() => {
    popoverRef.current = popover;
  }, [popover]);

  useEffect(() => {
    onFeedbackRef.current = onFeedback;
  }, [onFeedback]);

  useEffect(() => {
    const clearPressTimer = () => {
      if (pressTimerRef.current !== null) {
        window.clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
      pressTargetRef.current = null;
      pressOriginRef.current = null;
      pressPointerIdRef.current = null;
    };

    const hidePopover = () => {
      if (popoverRef.current !== null) {
        popoverRef.current = null;
        setPopover(null);
      }
    };

    const isInsidePopover = (target: EventTarget | null): boolean =>
      target instanceof Element && Boolean(target.closest('[data-input-paste-popover="true"]'));

    const openPopoverFor = (el: EditableInputElement, x?: number, y?: number) => {
      if (!isActiveWithCollapsedCaret(el)) return;
      const existing = popoverRef.current;
      if (existing && existing.target === el && performance.now() - existing.openedAt < 700) {
        return;
      }
      const next = computePopoverPosition(el, x, y);
      popoverRef.current = next;
      setPopover(next);
    };

    const startLongPress = (
      el: EditableInputElement,
      x: number,
      y: number,
      pointerId: number | null
    ) => {
      const now = performance.now();
      // Deduplicate touchstart + pointerdown firing together for the same press
      if (
        pressTimerRef.current !== null &&
        pressTargetRef.current === el &&
        now - pressStartedAtRef.current < 120
      ) {
        return;
      }

      clearPressTimer();
      if (!isActiveWithCollapsedCaret(el)) return;

      pressTargetRef.current = el;
      pressOriginRef.current = { x, y };
      pressStartedAtRef.current = now;
      pressPointerIdRef.current = pointerId;

      pressTimerRef.current = window.setTimeout(() => {
        const target = pressTargetRef.current;
        const origin = pressOriginRef.current;
        pressTimerRef.current = null;
        pressTargetRef.current = null;
        pressOriginRef.current = null;
        pressPointerIdRef.current = null;

        if (!target || !origin) return;
        openPopoverFor(target, origin.x, origin.y);
      }, LONG_PRESS_MS);
    };

    const handlePointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') {
        lastNonMouseDownAtRef.current = performance.now();
      } else if (performance.now() - lastNonMouseDownAtRef.current < 700) {
        return;
      }

      if (isInsidePopover(e.target)) return;

      hidePopover();

      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) {
        clearPressTimer();
        return;
      }

      const target = resolveEditableTarget(e.target);
      if (!target || !isActiveWithCollapsedCaret(target)) {
        clearPressTimer();
        return;
      }

      startLongPress(target, e.clientX, e.clientY, e.pointerId);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!pressOriginRef.current) return;
      if (pressPointerIdRef.current !== null && e.pointerId !== pressPointerIdRef.current) return;
      const dx = e.clientX - pressOriginRef.current.x;
      const dy = e.clientY - pressOriginRef.current.y;
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
        clearPressTimer();
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      // Do NOT cancel on pointercancel because Android WebView fires pointercancel
      // while the finger is still held down during long-press.
      if (pressPointerIdRef.current === null || e.pointerId === pressPointerIdRef.current) {
        clearPressTimer();
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      lastNonMouseDownAtRef.current = performance.now();
      if (isInsidePopover(e.target)) return;

      const now = performance.now();
      // If pointerdown already opened/started for this exact touch, don't dismiss or reset
      if (pressTimerRef.current !== null && now - pressStartedAtRef.current < 120) {
        return;
      }

      hidePopover();

      if (e.touches.length !== 1) {
        clearPressTimer();
        return;
      }

      const target = resolveEditableTarget(e.target);
      if (!target || !isActiveWithCollapsedCaret(target)) {
        clearPressTimer();
        return;
      }

      const touch = e.touches[0];
      startLongPress(target, touch.clientX, touch.clientY, null);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!pressOriginRef.current) return;
      const touch = e.touches[0];
      if (!touch) {
        clearPressTimer();
        return;
      }
      const dx = touch.clientX - pressOriginRef.current.x;
      const dy = touch.clientY - pressOriginRef.current.y;
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
        clearPressTimer();
      }
    };

    const handleTouchEnd = () => {
      lastNonMouseDownAtRef.current = performance.now();
      clearPressTimer();
    };

    const handleContextMenu = (e: MouseEvent) => {
      if (isInsidePopover(e.target)) {
        e.preventDefault();
        return;
      }
      const target = resolveEditableTarget(e.target);
      if (target && isActiveWithCollapsedCaret(target)) {
        e.preventDefault();
        clearPressTimer();
        openPopoverFor(target, e.clientX, e.clientY);
      }
    };

    const handleSelectionChange = () => {
      const pendingTarget = pressTargetRef.current;
      if (pendingTarget && !isActiveWithCollapsedCaret(pendingTarget)) {
        clearPressTimer();
      }
      const openState = popoverRef.current;
      if (!openState) return;
      if (!openState.target.isConnected || document.activeElement !== openState.target) {
        hidePopover();
        return;
      }
      if (!isCollapsedSelection(openState.target)) {
        // Right after our 380ms caret long-press opens the Paste popover, Android WebView's
        // delayed ~500ms long-press handler may auto-select an adjacent word while the user's
        // finger is still lifting. Restore the collapsed caret within this short guard window.
        if (
          openState.openedCaret !== null &&
          performance.now() - openState.openedAt < POST_OPEN_SELECTION_GUARD_MS
        ) {
          try {
            const clamped = Math.min(openState.openedCaret, openState.target.value.length);
            openState.target.setSelectionRange(clamped, clamped);
            return;
          } catch {
            // fall through to hide
          }
        }
        hidePopover();
      }
    };

    const handleFocusOut = (e: FocusEvent) => {
      if (isInsidePopover(e.relatedTarget)) return;
      const openState = popoverRef.current;
      if (openState && e.target === openState.target) {
        hidePopover();
      }
      if (pressTargetRef.current && e.target === pressTargetRef.current) {
        clearPressTimer();
      }
    };

    const handleInputOrKey = () => {
      clearPressTimer();
      hidePopover();
    };

    const handleScroll = (e: Event) => {
      // Never cancel an in-progress long-press on minor input/modal scroll jitter.
      const openState = popoverRef.current;
      if (!openState) return;
      if (e.target === openState.target) return;
      const rect = openState.target.getBoundingClientRect();
      if (
        Math.abs(rect.top - openState.anchorInputTop) > 12 ||
        Math.abs(rect.left - openState.anchorInputLeft) > 12
      ) {
        hidePopover();
      }
    };

    const handleResize = () => {
      const openState = popoverRef.current;
      if (!openState) return;
      if (!isActiveWithCollapsedCaret(openState.target)) {
        hidePopover();
        return;
      }
      const next = computePopoverPosition(openState.target);
      popoverRef.current = next;
      setPopover(next);
    };

    // Native Android bridge: catches long-presses on both the input AND Android's native
    // teardrop insertion handle (which consumes touch events before WebView JS sees them)
    // as well as SilentActionMode triggers.
    const unsubscribeNative = subscribeNativeInputLongPress((event) => {
      const active = document.activeElement;
      if (!isEditableInput(active) || !isCollapsedSelection(active)) return;

      if (event.source === 'touch') {
        if (typeof event.x === 'number' && typeof event.y === 'number') {
          if (!isPointNearInput(active, event.x, event.y)) return;
        }
        clearPressTimer();
        openPopoverFor(active, event.x, event.y);
        return;
      }

      if (event.source === 'actionMode') {
        clearPressTimer();
        openPopoverFor(active);
      }
    });

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', handleTouchMove, { capture: true, passive: true });
    window.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
    window.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('focusout', handleFocusOut, true);
    document.addEventListener('input', handleInputOrKey, true);
    document.addEventListener('keydown', handleInputOrKey, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);

    return () => {
      clearPressTimer();
      unsubscribeNative();
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('touchstart', handleTouchStart, true);
      window.removeEventListener('touchmove', handleTouchMove, true);
      window.removeEventListener('touchend', handleTouchEnd, true);
      window.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('focusout', handleFocusOut, true);
      document.removeEventListener('input', handleInputOrKey, true);
      document.removeEventListener('keydown', handleInputOrKey, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const handlePasteAction = async () => {
    const now = performance.now();
    if (now - lastPasteTriggerAtRef.current < 350) return;
    lastPasteTriggerAtRef.current = now;

    const activePopover = popoverRef.current;
    popoverRef.current = null;
    setPopover(null);

    if (!activePopover) return;
    const { target, openedCaret } = activePopover;
    if (!target.isConnected || target.disabled || target.readOnly) return;

    const result = await readSystemClipboardText();
    if (!result.ok) {
      onFeedbackRef.current?.('无法读取系统剪贴板');
      return;
    }
    if (!result.text) {
      onFeedbackRef.current?.('剪贴板为空');
      return;
    }

    if (document.activeElement !== target) {
      target.focus({ preventScroll: true });
    }
    insertTextAtCaret(target, result.text, openedCaret);
  };

  if (!popover || typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-input-paste-popover="true"
      style={{
        left: `${popover.left}px`,
        top: `${popover.top}px`,
        transform:
          popover.placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[9999] select-none"
    >
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
        }}
        onTouchEnd={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const touch = e.changedTouches[0];
          if (touch) {
            const rect = e.currentTarget.getBoundingClientRect();
            const slack = 16;
            const inside =
              touch.clientX >= rect.left - slack &&
              touch.clientX <= rect.right + slack &&
              touch.clientY >= rect.top - slack &&
              touch.clientY <= rect.bottom + slack;
            if (!inside) return;
          }
          void handlePasteAction();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void handlePasteAction();
        }}
        aria-label="粘贴系统剪贴板内容"
        className="h-9 px-3.5 rounded-xl inline-flex items-center gap-1.5 bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] text-[13px] font-medium text-[var(--fei-text-primary)] shadow-md dark:shadow-xl hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] transition-colors whitespace-nowrap select-none cursor-pointer"
      >
        <ClipboardPaste className="w-3.5 h-3.5 text-[var(--fei-text-muted)]" strokeWidth={1.9} />
        <span>粘贴</span>
      </button>
    </div>,
    document.body
  );
};

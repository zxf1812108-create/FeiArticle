import React, { useEffect, useRef, useState } from 'react';
import { ClipboardPaste } from 'lucide-react';
import { readSystemClipboardText } from '../utils/readerNative';

type EditableInputElement = HTMLInputElement | HTMLTextAreaElement;

interface PastePopoverState {
  target: EditableInputElement;
  left: number;
  top: number;
  placement: 'above' | 'below';
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

const LONG_PRESS_MS = 420;
const MOVE_CANCEL_PX = 14;
const POPOVER_HALF_WIDTH = 52;
const POPOVER_EDGE_MARGIN = 12;
const POPOVER_GAP_PX = 10;
const TOP_FLIP_THRESHOLD = 56;

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

function getCaretViewportRect(
  el: EditableInputElement
): { x: number; top: number; bottom: number } | null {
  if (el instanceof HTMLInputElement && (el.type || '').toLowerCase() === 'password') {
    return null;
  }
  let caretIndex: number | null = null;
  try {
    caretIndex = el.selectionStart;
  } catch {
    caretIndex = null;
  }
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

  const valueBefore = el.value.slice(0, caretIndex);
  mirror.textContent = valueBefore;

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
  fallbackX: number,
  fallbackY: number
): PastePopoverState {
  const inputRect = el.getBoundingClientRect();
  const caretRect = getCaretViewportRect(el);

  const anchorX = caretRect
    ? caretRect.x
    : Math.max(inputRect.left + 8, Math.min(inputRect.right - 8, fallbackX));
  const anchorTop = caretRect
    ? caretRect.top
    : el instanceof HTMLTextAreaElement
      ? Math.max(inputRect.top, Math.min(inputRect.bottom, fallbackY - 12))
      : inputRect.top;
  const anchorBottom = caretRect
    ? caretRect.bottom
    : el instanceof HTMLTextAreaElement
      ? Math.max(inputRect.top, Math.min(inputRect.bottom, fallbackY + 12))
      : inputRect.bottom;

  const minLeft = POPOVER_HALF_WIDTH + POPOVER_EDGE_MARGIN;
  const maxLeft = Math.max(minLeft, window.innerWidth - POPOVER_HALF_WIDTH - POPOVER_EDGE_MARGIN);
  const clampedLeft = Math.max(minLeft, Math.min(maxLeft, anchorX));

  if (anchorTop >= TOP_FLIP_THRESHOLD) {
    return {
      target: el,
      left: clampedLeft,
      top: Math.max(8, anchorTop - POPOVER_GAP_PX),
      placement: 'above',
    };
  }

  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  return {
    target: el,
    left: clampedLeft,
    top: Math.min(viewportHeight - 48, anchorBottom + POPOVER_GAP_PX),
    placement: 'below',
  };
}

function insertTextAtCaret(el: EditableInputElement, rawText: string): boolean {
  if (!el.isConnected || el.disabled || el.readOnly) return false;

  const normalized =
    el instanceof HTMLTextAreaElement
      ? rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      : rawText.replace(/[\r\n]/g, '');

  const currentValue = el.value;
  let start = currentValue.length;
  let end = currentValue.length;
  try {
    if (typeof el.selectionStart === 'number') start = el.selectionStart;
    if (typeof el.selectionEnd === 'number') end = el.selectionEnd;
  } catch {
    start = currentValue.length;
    end = currentValue.length;
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
  const lastTouchEventAtRef = useRef<number>(0);

  const pressTimerRef = useRef<number | null>(null);
  const pressTargetRef = useRef<EditableInputElement | null>(null);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const pressModeRef = useRef<'touch' | 'mouse' | null>(null);

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
      pressModeRef.current = null;
    };

    const hidePopover = () => {
      if (popoverRef.current !== null) {
        popoverRef.current = null;
        setPopover(null);
      }
    };

    const isInsidePopover = (target: EventTarget | null): boolean =>
      target instanceof Element && Boolean(target.closest('[data-input-paste-popover="true"]'));

    const openPopoverFor = (el: EditableInputElement, x: number, y: number) => {
      if (!isActiveWithCollapsedCaret(el)) return;
      const next = computePopoverPosition(el, x, y);
      popoverRef.current = next;
      setPopover(next);
    };

    const startLongPress = (
      el: EditableInputElement,
      x: number,
      y: number,
      mode: 'touch' | 'mouse'
    ) => {
      clearPressTimer();
      if (!isActiveWithCollapsedCaret(el)) return;

      pressTargetRef.current = el;
      pressOriginRef.current = { x, y };
      pressModeRef.current = mode;

      pressTimerRef.current = window.setTimeout(() => {
        const target = pressTargetRef.current;
        const origin = pressOriginRef.current;
        pressTimerRef.current = null;
        pressTargetRef.current = null;
        pressOriginRef.current = null;
        pressModeRef.current = null;

        if (!target || !origin) return;
        openPopoverFor(target, origin.x, origin.y);
      }, LONG_PRESS_MS);
    };

    const handleTouchStart = (e: TouchEvent) => {
      lastTouchEventAtRef.current = performance.now();
      if (isInsidePopover(e.target)) return;

      hidePopover();

      if (e.touches.length !== 1) {
        clearPressTimer();
        return;
      }

      const target = e.target;
      if (!isEditableInput(target) || !isActiveWithCollapsedCaret(target)) {
        clearPressTimer();
        return;
      }

      const touch = e.touches[0];
      startLongPress(target, touch.clientX, touch.clientY, 'touch');
    };

    const handleTouchMove = (e: TouchEvent) => {
      lastTouchEventAtRef.current = performance.now();
      if (pressModeRef.current !== 'touch' || !pressOriginRef.current) return;
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
      lastTouchEventAtRef.current = performance.now();
      // Do NOT cancel on touchcancel because Android WebView fires touchcancel
      // while the finger is still held down during long-press.
      if (pressModeRef.current === 'touch') {
        clearPressTimer();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      // Ignore compatibility mouse events synthesized right after touch gestures
      if (performance.now() - lastTouchEventAtRef.current < 700) return;
      if (isInsidePopover(e.target)) return;

      hidePopover();

      if (e.button !== 0) {
        clearPressTimer();
        return;
      }

      const target = e.target;
      if (!isEditableInput(target) || !isActiveWithCollapsedCaret(target)) {
        clearPressTimer();
        return;
      }

      startLongPress(target, e.clientX, e.clientY, 'mouse');
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (pressModeRef.current !== 'mouse' || !pressOriginRef.current) return;
      const dx = e.clientX - pressOriginRef.current.x;
      const dy = e.clientY - pressOriginRef.current.y;
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
        clearPressTimer();
      }
    };

    const handleMouseUp = () => {
      if (pressModeRef.current === 'mouse') {
        clearPressTimer();
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      if (isInsidePopover(e.target)) {
        e.preventDefault();
        return;
      }
      const target = e.target;
      if (isEditableInput(target) && isActiveWithCollapsedCaret(target)) {
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
      if (openState && !isActiveWithCollapsedCaret(openState.target)) {
        hidePopover();
      }
    };

    const handleDismissEvents = () => {
      clearPressTimer();
      hidePopover();
    };

    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', handleTouchMove, { capture: true, passive: true });
    document.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('focusout', handleDismissEvents, true);
    document.addEventListener('input', handleDismissEvents, true);
    document.addEventListener('keydown', handleDismissEvents, true);
    window.addEventListener('scroll', handleDismissEvents, true);
    window.addEventListener('resize', handleDismissEvents);

    return () => {
      clearPressTimer();
      document.removeEventListener('touchstart', handleTouchStart, true);
      document.removeEventListener('touchmove', handleTouchMove, true);
      document.removeEventListener('touchend', handleTouchEnd, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('focusout', handleDismissEvents, true);
      document.removeEventListener('input', handleDismissEvents, true);
      document.removeEventListener('keydown', handleDismissEvents, true);
      window.removeEventListener('scroll', handleDismissEvents, true);
      window.removeEventListener('resize', handleDismissEvents);
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
    const { target } = activePopover;
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
    insertTextAtCaret(target, result.text);
  };

  if (!popover) return null;

  return (
    <div
      data-input-paste-popover="true"
      style={{
        left: `${popover.left}px`,
        top: `${popover.top}px`,
        transform:
          popover.placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[70] select-none"
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
    </div>
  );
};

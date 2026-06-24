import { useRef, useEffect, useCallback } from 'react';
import MonacoEditor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNS from 'monaco-editor';

// ─── Public types (imported by Room.tsx) ──────────────────────

export interface CursorPosition {
  lineNumber: number;
  column: number;
}

export interface CursorSelection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface RemoteCursor {
  socketId: string;
  name: string;
  color: string; // HSL string from nameToColor()
  position: CursorPosition;
  selection: CursorSelection | null;
}

// ─── Props ────────────────────────────────────────────────────

interface CodeEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  fileName?: string;
  remoteCursors?: RemoteCursor[];
  /** Called on cursor/selection change; Room.tsx throttles the socket emit */
  onCursorChange?: (position: CursorPosition, selection: CursorSelection | null) => void;
}

// ─── Helpers ──────────────────────────────────────────────────

function getLanguage(fileName?: string): string {
  const ext = fileName?.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'javascript', ts: 'typescript',
    jsx: 'javascript', tsx: 'typescript',
    css: 'css', html: 'html', json: 'json',
    md: 'markdown', py: 'python', rs: 'rust',
    go: 'go', sh: 'shell', yaml: 'yaml', yml: 'yaml',
    sql: 'sql', xml: 'xml', vue: 'html',
  };
  return map[ext] ?? 'plaintext';
}

function isNonEmptySelection(sel: CursorSelection): boolean {
  return sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn;
}

/**
 * Convert an HSL color string to rgba(r,g,b,a) for use in CSS backgrounds.
 * Monaco decorations require a real stylesheet entry — we can't pass HSL with opacity inline.
 */
function hslToRgba(hsl: string, alpha: number): string {
  const m = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!m) return `rgba(124, 92, 255, ${alpha})`;
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const ch = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return `rgba(${ch(0)}, ${ch(8)}, ${ch(4)}, ${alpha})`;
}

// ─── Component ────────────────────────────────────────────────

export default function CodeEditor({
  value,
  onChange,
  fileName,
  remoteCursors = [],
  onCursorChange,
}: CodeEditorProps) {
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof MonacoNS | null>(null);

  // One decorations collection shared across all remote users' selections
  const selectionsCollRef = useRef<MonacoNS.editor.IEditorDecorationsCollection | null>(null);

  // Map of socketId → IContentWidget (the cursor bar + label widget)
  const widgetMapRef = useRef<Map<string, MonacoNS.editor.IContentWidget>>(new Map());

  // Stable ref for the cursor callback so handleMount doesn't need to re-register
  const onCursorChangeRef = useRef(onCursorChange);
  useEffect(() => { onCursorChangeRef.current = onCursorChange; }, [onCursorChange]);

  // ── Editor mount ─────────────────────────────────────────────

  const handleMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor;
    monacoRef.current = monacoInstance;
    selectionsCollRef.current = editor.createDecorationsCollection([]);

    // Emit local cursor + selection on every position change.
    // Room.tsx throttles the actual socket.emit to 50ms.
    editor.onDidChangeCursorPosition((e) => {
      if (!onCursorChangeRef.current) return;
      const sel = editor.getSelection();
      onCursorChangeRef.current(
        { lineNumber: e.position.lineNumber, column: e.position.column },
        sel && !sel.isEmpty()
          ? {
              startLineNumber: sel.startLineNumber,
              startColumn: sel.startColumn,
              endLineNumber: sel.endLineNumber,
              endColumn: sel.endColumn,
            }
          : null,
      );
    });
  }, []);

  // ── Remote cursor rendering ───────────────────────────────────
  //
  // Strategy:
  //   • Cursor bar + name label → Monaco IContentWidget (pixel-perfect positioning)
  //   • Selection highlight     → Monaco decoration with dynamically-injected CSS class
  //
  // On every remoteCursors change we tear down all old widgets and rebuild.
  // At 50ms throttle / ~5 users this is ~100 widget ops/second — well within Monaco's budget.

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const widgetMap = widgetMapRef.current;

    // ── 1. Remove all old cursor widgets ──────────────────────
    widgetMap.forEach((w) => {
      try { editor.removeContentWidget(w); } catch { /* editor may already be destroyed */ }
    });
    widgetMap.clear();

    // ── 2. Add a content widget per remote user ───────────────
    for (const cursor of remoteCursors) {
      // Container: zero-width so it doesn't push text, overflow:visible so label peeks out
      const container = document.createElement('div');
      container.style.cssText = [
        'position:absolute',
        'width:0',
        'height:20px',
        'overflow:visible',
        'pointer-events:none',
        'user-select:none',
      ].join(';');

      // Cursor bar — a 2 px colored vertical line
      const bar = document.createElement('div');
      bar.style.cssText = [
        'position:absolute',
        'top:0',
        'left:0',
        'width:2px',
        'height:100%',
        `background:${cursor.color}`,
        'pointer-events:none',
        'border-radius:1px',
      ].join(';');
      container.appendChild(bar);

      // Name label — floats above the cursor line
      const label = document.createElement('div');
      label.textContent = cursor.name;
      label.style.cssText = [
        'position:absolute',
        'top:-20px',
        'left:-1px',
        `background:${cursor.color}`,
        'color:#fff',
        'font:600 11px/18px Inter,system-ui,sans-serif',
        'padding:0 5px',
        'border-radius:3px 3px 3px 0',
        'white-space:nowrap',
        'pointer-events:none',
        'user-select:none',
        'z-index:999',
        'box-shadow:0 1px 4px rgba(0,0,0,0.35)',
      ].join(';');
      container.appendChild(label);

      const widget: MonacoNS.editor.IContentWidget = {
        getId: () => `remote-cursor-${cursor.socketId}`,
        getDomNode: () => container,
        getPosition: () => ({
          position: cursor.position,
          preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
        }),
        allowEditorOverflow: true, // Let label escape the editor clip rect
      };

      editor.addContentWidget(widget);
      widgetMap.set(cursor.socketId, widget);
    }

    // ── 3. Update selection decorations ───────────────────────
    const selectionDecos = remoteCursors
      .filter((c) => c.selection && isNonEmptySelection(c.selection))
      .map((c) => ({
        range: new monaco.Range(
          c.selection!.startLineNumber, c.selection!.startColumn,
          c.selection!.endLineNumber,   c.selection!.endColumn,
        ),
        options: {
          className: `rsel-${c.socketId.replace(/[^a-z0-9]/gi, '_')}`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }));

    selectionsCollRef.current?.set(selectionDecos);

    // ── 4. Inject/update CSS for selection backgrounds ────────
    // Monaco decorations only accept className — inject per-user CSS dynamically.
    const styleId = 'codetogether-remote-cursors-css';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = remoteCursors
      .map((c) => {
        const safe = c.socketId.replace(/[^a-z0-9]/gi, '_');
        // hslToRgba gives a properly transparent bg for the selection highlight
        return `.rsel-${safe}{background:${hslToRgba(c.color, 0.18)};border-radius:2px;}`;
      })
      .join('\n');

    // ── Cleanup on unmount / before next effect run ───────────
    return () => {
      widgetMap.forEach((w) => {
        try { editor.removeContentWidget(w); } catch { /* editor may already be disposed */ }
      });
      widgetMap.clear();
    };
  }, [remoteCursors]);

  // ─── Render ──────────────────────────────────────────────────

  return (
    <MonacoEditor
      height="100%"
      language={getLanguage(fileName)}
      theme="vs-dark"
      value={value}
      onChange={onChange}
      onMount={handleMount}
      options={{
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontLigatures: true,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        padding: { top: 16, bottom: 16 },
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        smoothScrolling: true,
        wordWrap: 'on',
        tabSize: 2,
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
      }}
      loading={
        <div className="editor-loading">
          <div className="editor-loading-spinner" />
          <span>Loading editor…</span>
        </div>
      }
    />
  );
}

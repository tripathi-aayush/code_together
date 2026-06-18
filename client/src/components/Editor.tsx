import Editor from '@monaco-editor/react';

interface CodeEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  fileName?: string;
}

/** Map file extensions to Monaco language IDs */
function getLanguage(fileName?: string): string {
  const ext = fileName?.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'javascript', ts: 'typescript',
    jsx: 'javascript', tsx: 'typescript',
    css: 'css', html: 'html',
    json: 'json', md: 'markdown',
    py: 'python', rs: 'rust',
    go: 'go', sh: 'shell',
    yaml: 'yaml', yml: 'yaml',
    sql: 'sql', xml: 'xml',
  };
  return map[ext] ?? 'plaintext';
}

export default function CodeEditor({ value, onChange, fileName }: CodeEditorProps) {
  return (
    <Editor
      height="100%"
      language={getLanguage(fileName)}
      theme="vs-dark"
      value={value}
      onChange={onChange}
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

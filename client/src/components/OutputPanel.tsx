import { useRef, useEffect } from 'react';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  language: string;
  fileName: string;
  executionTime: number;
}

interface OutputPanelProps {
  result: ExecutionResult | null;
  isOpen: boolean;
  onToggle: () => void;
  onClear: () => void;
}

export default function OutputPanel({ result, isOpen, onToggle, onClear }: OutputPanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (isOpen && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [result, isOpen]);

  const handleClearClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent toggling the panel
    onClear();
  };

  return (
    <div className={`output-panel ${isOpen ? 'output-open' : 'output-closed'}`} aria-label="Output console">
      {/* Header bar — always visible, acts as the toggle button */}
      <div 
        className="output-header" 
        onClick={onToggle} 
        aria-expanded={isOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="output-header-left">
          <span className="output-icon">💻</span>
          <span className="output-title">Output</span>
          {result && (
            <>
              <span className="output-header-file">{result.fileName}</span>
              <span className="output-header-lang">{result.language}</span>
              {result.fileName.endsWith('.js') && result.language === 'typescript-deno' && (
                <span className="output-header-note" style={{ color: 'var(--text-muted)', fontSize: '10px', marginLeft: '4px' }}>
                  (running via Deno)
                </span>
              )}
            </>
          )}
        </span>
        <span className="output-header-right">
          {result && (
            <span className="output-header-meta">
              <span className={`output-badge ${result.exitCode === 0 ? 'success' : 'error'}`}>
                Exit {result.exitCode}
              </span>
              <span className="output-time">
                ran in {(result.executionTime / 1000).toFixed(2)}s
              </span>
              <button 
                className="output-clear-btn" 
                onClick={handleClearClick} 
                title="Clear output"
                type="button"
              >
                &times;
              </button>
            </span>
          )}
          <span className={`output-chevron ${isOpen ? 'up' : 'down'}`}>›</span>
        </span>
      </div>

      {/* Panel content area */}
      <div className="output-content" ref={contentRef}>
        {!result ? (
          <div className="output-empty">No code execution results yet. Click 'Run' to execute.</div>
        ) : (result.stdout === '' && result.stderr === '') ? (
          <div className="output-empty">No output</div>
        ) : (
          <pre className="output-pre">
            {result.stdout && <span className="output-stdout">{result.stdout}</span>}
            {result.stderr && <span className="output-stderr">{result.stderr}</span>}
          </pre>
        )}
      </div>
    </div>
  );
}

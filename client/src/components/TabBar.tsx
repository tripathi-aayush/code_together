/** Maps a file extension to an icon + accent color for the tab bar. */
function getFileDisplay(fileName: string): { icon: string; color: string } {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, { icon: string; color: string }> = {
    js:   { icon: 'JS',  color: '#f7df1e' },
    ts:   { icon: 'TS',  color: '#3178c6' },
    jsx:  { icon: 'JSX', color: '#61dafb' },
    tsx:  { icon: 'TSX', color: '#61dafb' },
    css:  { icon: 'CSS', color: '#e879f9' },
    html: { icon: 'HTM', color: '#e34c26' },
    json: { icon: 'JSON',color: '#cbcb41' },
    md:   { icon: 'MD',  color: '#9090a8' },
    py:   { icon: 'PY',  color: '#3572a5' },
    rs:   { icon: 'RS',  color: '#dea584' },
    go:   { icon: 'GO',  color: '#00add8' },
    sql:  { icon: 'SQL', color: '#e48e00' },
    yaml: { icon: 'YML', color: '#cc1018' },
    yml:  { icon: 'YML', color: '#cc1018' },
    sh:   { icon: 'SH',  color: '#89e051' },
    xml:  { icon: 'XML', color: '#f89820' },
    vue:  { icon: 'VUE', color: '#41b883' },
  };
  return map[ext] ?? { icon: 'TXT', color: '#9090a8' };
}

interface TabBarProps {
  roomId: string;
  activeFile: string;
  /** Optional: sockets of remote users on this file — dot indicators */
  remoteCursorCount?: number;
  onRun: () => void;
  isExecuting: boolean;
  cooldown: number;
  isExecutable: boolean;
}

export default function TabBar({
  roomId,
  activeFile,
  remoteCursorCount = 0,
  onRun,
  isExecuting,
  cooldown,
  isExecutable,
}: TabBarProps) {
  const { icon, color } = getFileDisplay(activeFile);

  return (
    <div className="tab-bar" role="tablist" aria-label="Active file">
      {/* Breadcrumb: roomId / filename */}
      <div className="tab-breadcrumb">
        <span className="tab-breadcrumb-room">{roomId}</span>
        <span className="tab-breadcrumb-sep">/</span>
        <span className="tab-breadcrumb-file">{activeFile}</span>
      </div>

      {/* Active file tab */}
      <div className="tab-active" role="tab" aria-selected={true}>
        <span
          className="tab-lang-badge"
          style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}
        >
          {icon}
        </span>
        <span className="tab-file-name">{activeFile}</span>

        {/* Show how many remote users are on this file */}
        {remoteCursorCount > 0 && (
          <span className="tab-cursor-count" title={`${remoteCursorCount} user${remoteCursorCount === 1 ? '' : 's'} here`}>
            {remoteCursorCount}
          </span>
        )}
      </div>

      {/* Run button */}
      <button
        className={`tab-run-btn ${cooldown > 0 ? 'cooldown' : ''} ${isExecuting ? 'executing' : ''}`}
        onClick={onRun}
        disabled={isExecuting || cooldown > 0 || !isExecutable}
        title={!isExecutable ? "This file type cannot be executed." : (cooldown > 0 ? `Cooldown (${cooldown}s)` : "Run code")}
        type="button"
      >
        {isExecuting ? (
          <span>⌛ Running...</span>
        ) : cooldown > 0 ? (
          <span>⌛ {cooldown}s</span>
        ) : (
          <>▶ Run</>
        )}
      </button>

      <div className="tab-spacer" />
    </div>
  );
}

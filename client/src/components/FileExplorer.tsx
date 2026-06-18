import { useState, useRef, useEffect, type KeyboardEvent } from 'react';

interface RawCursorData {
  fileName: string;
}

interface FileExplorerProps {
  files: string[];
  activeFile: string;
  onFileSelect: (name: string) => void;
  onFileCreate: (name: string) => void;
  onFileDelete: (name: string) => void;
  onFileRename: (oldName: string, newName: string) => void;
  /** Optional: remoteCursorData map for showing per-file user indicator dots */
  remoteCursorData?: Record<string, RawCursorData>;
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const icons: Record<string, string> = {
    js: '🟨', ts: '🔷', tsx: '⚛️', jsx: '⚛️',
    css: '🎨', html: '🌐', json: '📋', md: '📝',
    py: '🐍', rs: '🦀', go: '🐹', sh: '⚙️',
    sql: '🗄️', yaml: '📐', yml: '📐', vue: '💚',
  };
  return icons[ext] ?? '📄';
}

export default function FileExplorer({
  files, activeFile, onFileSelect, onFileCreate, onFileDelete, onFileRename,
  remoteCursorData = {},
}: FileExplorerProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const newFileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCreating) newFileInputRef.current?.focus();
  }, [isCreating]);

  useEffect(() => {
    if (renamingFile) renameInputRef.current?.focus();
  }, [renamingFile]);

  useEffect(() => {
    if (!deleteConfirm) return;
    const handler = () => setDeleteConfirm(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [deleteConfirm]);

  // Count remote users per file
  const usersPerFile: Record<string, number> = {};
  Object.values(remoteCursorData).forEach(({ fileName }) => {
    usersPerFile[fileName] = (usersPerFile[fileName] ?? 0) + 1;
  });

  // ─── Create file ─────────────────────────────────────────────

  const submitCreate = () => {
    const name = newFileName.trim();
    if (name && !files.includes(name)) {
      onFileCreate(name);
    }
    setNewFileName('');
    setIsCreating(false);
  };

  const handleCreateKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submitCreate();
    if (e.key === 'Escape') { setNewFileName(''); setIsCreating(false); }
  };

  // ─── Rename file ─────────────────────────────────────────────

  const startRename = (name: string) => {
    setRenamingFile(name);
    setRenameValue(name);
  };

  const submitRename = () => {
    if (renamingFile && renameValue.trim() && renameValue.trim() !== renamingFile) {
      onFileRename(renamingFile, renameValue.trim());
    }
    setRenamingFile(null);
    setRenameValue('');
  };

  const handleRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submitRename();
    if (e.key === 'Escape') { setRenamingFile(null); setRenameValue(''); }
  };

  // ─── Delete file ─────────────────────────────────────────────

  const handleDeleteClick = (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    if (deleteConfirm === name) {
      onFileDelete(name);
      setDeleteConfirm(null);
    } else {
      setDeleteConfirm(name);
    }
  };

  return (
    <div className="file-explorer">
      {/* Header */}
      <div className="file-explorer-header">
        <span className="file-explorer-title">
          Files
          {files.length > 0 && (
            <span className="file-count-badge">{files.length}</span>
          )}
        </span>
        <button
          className="fe-new-btn"
          onClick={() => setIsCreating(true)}
          title="New file (Enter name, press Enter)"
          aria-label="Create new file"
        >
          +
        </button>
      </div>

      {/* File list */}
      <ul className="file-list" role="listbox" aria-label="Files">
        {files.map((name) => (
          <li
            key={name}
            className={`file-item ${name === activeFile ? 'active' : ''}`}
            role="option"
            aria-selected={name === activeFile}
          >
            {renamingFile === name ? (
              <input
                ref={renameInputRef}
                className="file-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={submitRename}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Rename ${name}`}
              />
            ) : (
              <button
                className="file-item-btn"
                onClick={() => onFileSelect(name)}
                onDoubleClick={() => startRename(name)}
                title={`${name} — double-click to rename`}
              >
                <span className="file-icon" aria-hidden="true">{getFileIcon(name)}</span>
                <span className="file-name">{name}</span>
                {/* Remote cursor dot — shows how many users are on this file */}
                {usersPerFile[name] > 0 && (
                  <span
                    className="file-cursor-dot"
                    title={`${usersPerFile[name]} user${usersPerFile[name] > 1 ? 's' : ''} editing`}
                  >
                    {usersPerFile[name]}
                  </span>
                )}
              </button>
            )}

            {/* Delete button — shown on hover */}
            <button
              className={`file-delete-btn ${deleteConfirm === name ? 'confirming' : ''}`}
              onClick={(e) => handleDeleteClick(e, name)}
              title={deleteConfirm === name ? 'Click again to confirm delete' : 'Delete file'}
              aria-label={deleteConfirm === name ? `Confirm delete ${name}` : `Delete ${name}`}
            >
              {deleteConfirm === name ? '✓' : '×'}
            </button>
          </li>
        ))}

        {/* New file input row */}
        {isCreating && (
          <li className="file-item creating">
            <span className="file-icon" aria-hidden="true">📄</span>
            <input
              ref={newFileInputRef}
              className="file-new-input"
              placeholder="filename.js"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={handleCreateKeyDown}
              onBlur={submitCreate}
              aria-label="New file name"
            />
          </li>
        )}
      </ul>

      {/* Empty state */}
      {files.length === 0 && !isCreating && (
        <div className="file-explorer-empty">
          No files yet — click <strong>+</strong> to create one
        </div>
      )}
    </div>
  );
}

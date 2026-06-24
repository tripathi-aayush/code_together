import { useEffect, useRef, useState } from 'react';

export interface ActivityEntry {
  id: string;
  userName: string;
  color: string;
  action: string;   // "joined the room" | "left the room" | "created" | "deleted" | "renamed …→…" | "edited"
  target?: string;  // file name if applicable
  timestamp: string; // ISO string
}

interface ActivityLogProps {
  entries: ActivityEntry[];
  isOpen: boolean;
  onToggle: () => void;
}

/** Formats an ISO timestamp as a human-readable relative time. */
function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5)  return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Maps an action verb to a readable label and icon. */
function actionLabel(action: string): { icon: string; verb: string } {
  switch (action) {
    case 'joined the room': return { icon: '→', verb: 'joined' };
    case 'left the room':   return { icon: '←', verb: 'left' };
    case 'created':         return { icon: '+', verb: 'created' };
    case 'deleted':         return { icon: '−', verb: 'deleted' };
    case 'renamed':         return { icon: '↩', verb: 'renamed' };
    case 'edited':          return { icon: '✎', verb: 'edited' };
    default:                return { icon: '·', verb: action };
  }
}

export default function ActivityLog({ entries, isOpen, onToggle }: ActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Bump this every 30s to re-render all relative timestamps
  const [, setTick] = useState(0);
  // Track unseen entries when panel is collapsed
  const [unseenCount, setUnseenCount] = useState(0);
  const prevEntryCount = useRef(entries.length);

  // Live-update timestamps every 30 seconds
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll to the latest entry whenever the log grows or panel opens
  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, isOpen]);

  // Track unseen entries when collapsed
  useEffect(() => {
    const newCount = entries.length - prevEntryCount.current;
    if (newCount > 0 && !isOpen) {
      setUnseenCount(prev => prev + newCount);
    }
    prevEntryCount.current = entries.length;
  }, [entries.length, isOpen]);

  // Clear unseen count when panel opens
  if (isOpen && unseenCount !== 0) {
    setUnseenCount(0);
  }

  return (
    <div className={`activity-panel ${isOpen ? 'activity-open' : 'activity-closed'}`}>

      {/* Toggle header — always visible */}
      <button className="activity-header" onClick={onToggle} aria-expanded={isOpen}>
        <span className="activity-header-left">
          <span className="activity-icon">⚡</span>
          <span className="activity-title">Activity</span>
          {entries.length > 0 && (
            <span className="activity-badge">{Math.min(entries.length, 99)}{entries.length >= 100 ? '+' : ''}</span>
          )}
        </span>
        <span className="activity-header-right">
          {/* New activity pill — shown when collapsed and there are unseen entries */}
          {!isOpen && unseenCount > 0 && (
            <span className="activity-new-pill">
              ↓ {unseenCount} new
            </span>
          )}
          <span className={`activity-chevron ${isOpen ? 'up' : 'down'}`}>›</span>
        </span>
      </button>

      {/* Collapsible entries list */}
      {isOpen && (
        <div className="activity-entries" ref={scrollRef} role="log" aria-live="polite">
          {entries.length === 0 ? (
            <div className="activity-empty">No activity yet — start editing!</div>
          ) : (
            entries.map((entry) => {
              const { icon, verb } = actionLabel(entry.action);
              return (
                <div key={entry.id} className="activity-entry">
                  {/* Colored user initial chip */}
                  <div
                    className="activity-user-chip"
                    style={{ background: entry.color }}
                    title={entry.userName}
                  >
                    {entry.userName.charAt(0).toUpperCase()}
                  </div>

                  {/* Entry body */}
                  <div className="activity-entry-body">
                    <span className="activity-user-name">{entry.userName}</span>
                    <span className="activity-action-icon">{icon}</span>
                    <span className="activity-verb">{verb}</span>
                    {entry.target && (
                      <span className="activity-target" title={entry.target}>{entry.target}</span>
                    )}
                  </div>

                  {/* Relative timestamp — updates every 30s */}
                  <time
                    className="activity-time"
                    dateTime={entry.timestamp}
                    title={new Date(entry.timestamp).toLocaleTimeString()}
                  >
                    {relativeTime(entry.timestamp)}
                  </time>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

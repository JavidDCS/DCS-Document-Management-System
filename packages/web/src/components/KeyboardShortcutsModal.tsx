import { Command, Keyboard } from 'lucide-react';
import { Kbd, Modal } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  if (!open) return null;

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const cmdKey = isMac ? '⌘' : 'Ctrl';

  const shortcutGroups = [
    {
      title: 'General',
      shortcuts: [
        { keys: [cmdKey, 'K'], label: 'Open Command Palette' },
        { keys: ['?'], label: 'Show keyboard shortcuts' },
        { keys: ['Esc'], label: 'Close dialogs, menus, and modals' },
        { keys: ['T'], label: 'Toggle Light / Dark mode' },
      ],
    },
    {
      title: 'Navigation (Press sequentially)',
      shortcuts: [
        { keys: ['G', 'H'], label: 'Go to Dashboard' },
        { keys: ['G', 'D'], label: 'Go to Documents Library' },
        { keys: ['G', 'S'], label: 'Go to Send Documents' },
        { keys: ['G', 'A'], label: 'Go to Audit Log' },
        { keys: ['G', 'U'], label: 'Go to User Management' },
      ],
    },
  ];

  return (
    <Modal title="Keyboard Shortcuts" onClose={onClose} wide>
      <div className="space-y-6">
        <div className="flex items-center gap-3 rounded-lg bg-primary-soft/50 p-3 text-xs text-primary">
          <Keyboard className="size-4 shrink-0" aria-hidden="true" />
          <span>
            Press shortcuts anywhere in the application. Shortcuts are automatically paused when typing inside text inputs.
          </span>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          {shortcutGroups.map((group) => (
            <div key={group.title} className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              <ul className="divide-y divide-border/60 rounded-lg border border-border/80 bg-surface">
                {group.shortcuts.map((sc, idx) => (
                  <li key={idx} className="flex items-center justify-between px-3.5 py-2.5 text-sm">
                    <span className="text-foreground/90">{sc.label}</span>
                    <div className="flex items-center gap-1">
                      {sc.keys.map((k, kIdx) => (
                        <Kbd key={kIdx}>{k}</Kbd>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex justify-end pt-2">
          <button type="button" className="btn primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </Modal>
  );
}


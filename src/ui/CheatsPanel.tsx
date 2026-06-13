import { useEffect, useRef, useState } from 'react';
import type { Cheat } from '../io/cheats';
import { parseCheat } from '../io/cheats';
import { ErrorBoundary } from './ErrorBoundary';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  gameCode: string | null;
  cheats: Cheat[];
  onChange: (cheats: Cheat[]) => void;
  onClose: () => void;
}

// Cheats are persisted in localStorage keyed by the cart's 4-letter
// game code so each ROM has its own list. We rehydrate here whenever a
// new game is loaded — App passes the gameCode + current emu.cheats
// array in and we hand back updates via onChange.
const STORAGE_KEY_PREFIX = 'gba-recomp:cheats:';

export function loadCheatsFor(code: string): Cheat[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + code);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}
export function saveCheatsFor(code: string, cheats: Cheat[]): void {
  localStorage.setItem(STORAGE_KEY_PREFIX + code, JSON.stringify(cheats));
}

export function CheatsPanel({ open, gameCode, cheats, onChange, onClose }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Cheat>({ name: '', code: '', enabled: true });
  // Index pending a two-step delete confirm (avoids a nested modal +
  // its Esc-handling clash with this panel's own Esc-to-close).
  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  // Reset the draft / editor whenever the user navigates between games.
  useEffect(() => { setEditing(null); setConfirmDel(null); }, [gameCode]);

  const persist = (next: Cheat[]) => {
    onChange(next);
    if (gameCode) saveCheatsFor(gameCode, next);
  };

  const startAdd = () => {
    setDraft({ name: '', code: '', enabled: true });
    setEditing(-1);  // -1 sentinel = "new"
  };
  const startEdit = (i: number) => {
    setDraft({ ...cheats[i] });
    setEditing(i);
  };
  const cancelEdit = () => {
    setEditing(null);
    setDraft({ name: '', code: '', enabled: true });
  };
  const commit = () => {
    if (!draft.code.trim()) return;
    if (editing === -1) {
      persist([...cheats, { ...draft, name: draft.name.trim() || 'Untitled' }]);
    } else if (editing !== null) {
      persist(cheats.map((c, i) => (i === editing ? { ...draft, name: draft.name.trim() || 'Untitled' } : c)));
    }
    cancelEdit();
  };
  const toggleEnabled = (i: number) => {
    persist(cheats.map((c, j) => (j === i ? { ...c, enabled: !c.enabled } : c)));
  };
  const remove = (i: number) => {
    persist(cheats.filter((_, j) => j !== i));
    setConfirmDel(null);
    if (editing === i) cancelEdit();
  };

  // Export the game's cheats as a JSON file (round-trips with import).
  const onExport = () => {
    const blob = new Blob([JSON.stringify(cheats, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${gameCode || 'gba'}-cheats.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  // Import cheats from a JSON file (array of {name, code, enabled?}, or a
  // { cheats: [...] } wrapper). Appended to the existing list.
  const importInputRef = useRef<HTMLInputElement>(null);
  const onImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    file.text().then((text) => {
      const parsed = JSON.parse(text);
      const arr: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cheats) ? parsed.cheats : [];
      const incoming: Cheat[] = arr
        .filter((c): c is { name?: unknown; code?: unknown; enabled?: unknown } => !!c && typeof c === 'object')
        .filter((c) => typeof c.code === 'string' && c.code.trim() !== '')
        .map((c) => ({
          name: typeof c.name === 'string' && c.name.trim() ? c.name : 'Imported',
          code: c.code as string,
          enabled: c.enabled !== false,
        }));
      if (incoming.length) persist([...cheats, ...incoming]);
    }).catch(() => { /* malformed JSON — ignore */ });
  };

  // Parse the current draft so we can warn about syntax problems before
  // the user saves a code that does nothing.
  const draftParsed = parseCheat(draft.code);
  const supportedLines = draftParsed.filter((l) => l.type !== 'unsupported').length;
  const unsupportedLines = draftParsed.filter((l) => l.type === 'unsupported').length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cheats"
      subtitle={gameCode ? `game code ${gameCode}` : 'no ROM loaded'}
    >
      <ErrorBoundary label="Cheats" onClose={onClose} variant="inline">
        {!gameCode ? (
          <div className="py-8 text-center opacity-50 text-xs">
            Load a ROM to manage its cheats.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <div className="eyebrow">{cheats.length} cheat{cheats.length === 1 ? '' : 's'}</div>
              <div className="flex gap-2">
                <button onClick={() => importInputRef.current?.click()} className="btn !text-[10px]">Import</button>
                <button onClick={onExport} disabled={cheats.length === 0} className="btn !text-[10px]">Export</button>
              </div>
            </div>
            <input ref={importInputRef} type="file" accept="application/json,.json" onChange={onImport} className="hidden" />
            <ul className="space-y-1 mb-3">
              {cheats.length === 0 ? (
                <li className="py-6 text-center opacity-50 text-xs">No cheats yet — add one below.</li>
              ) : (
                cheats.map((c, i) => (
                  <li
                    key={i}
                    className={`flex items-center gap-3 p-2 rounded-md border ${
                      c.enabled
                        ? 'bg-[#2a4a3a] border-[#4a8a6a]'
                        : 'bg-[#1c1c22] border-[#2a2a30]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={() => toggleEnabled(i)}
                      className="w-3.5 h-3.5 accent-[#5060a0]"
                    />
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => startEdit(i)}>
                      <div className="text-xs font-medium truncate">{c.name}</div>
                      <div className="text-[10px] opacity-60 truncate font-mono">{c.code.split('\n')[0]}{c.code.includes('\n') ? ' …' : ''}</div>
                    </div>
                    <button
                      onClick={() => startEdit(i)}
                      className="bg-transparent border-0 text-[#9a9aa6] text-xs cursor-pointer px-2 hover:text-white"
                    >Edit</button>
                    {confirmDel === i ? (
                      <button
                        onClick={() => remove(i)}
                        onMouseLeave={() => setConfirmDel(null)}
                        className="bg-transparent border-0 text-red-400 text-[10px] font-bold cursor-pointer px-2"
                        title="Confirm delete"
                      >Delete?</button>
                    ) : (
                      <button
                        onClick={() => setConfirmDel(i)}
                        className="bg-transparent border-0 text-[#9a9aa6] text-sm cursor-pointer px-2 hover:text-red-400"
                        title="Remove cheat"
                      >🗑</button>
                    )}
                  </li>
                ))
              )}
            </ul>

            {editing === null ? (
              <button onClick={startAdd} className="btn w-full">+ Add cheat</button>
            ) : (
              <div className="well p-3 space-y-2">
                <div className="eyebrow">{editing === -1 ? 'New cheat' : 'Editing'}</div>
                <input
                  type="text"
                  placeholder="Name (e.g. Infinite money)"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="input w-full"
                />
                <textarea
                  placeholder={`Paste cheat codes — one per line.\nFormat: XXXXXXXX YYYYYYYY\n\nExample:\n02001234 000000FF`}
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  rows={5}
                  className="input w-full font-mono"
                />
                <div className="flex items-center justify-between text-[10px]">
                  <div className="opacity-60">
                    {supportedLines > 0 && <span>✓ {supportedLines} line{supportedLines > 1 ? 's' : ''} parsed</span>}
                    {unsupportedLines > 0 && <span className="text-amber-300 ml-2">⚠ {unsupportedLines} unsupported opcode{unsupportedLines > 1 ? 's' : ''}</span>}
                    {draftParsed.length === 0 && draft.code.trim() && <span className="text-red-300">malformed code</span>}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={cancelEdit} className="btn !text-[10px]">Cancel</button>
                    <button onClick={commit} className="btn btn-primary !text-[10px]">Save</button>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 text-[10px] opacity-50 leading-relaxed">
              Supports the standard 8-byte GameShark / CodeBreaker / Action Replay format
              for write opcodes (8/16/32-bit) and conditional equality checks.
              Encrypted codes need to be decrypted first.
              Cheats fire once per frame, persisting their value through normal game logic.
            </div>
          </>
        )}
      </ErrorBoundary>
    </Modal>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { unzipSync } from 'fflate';
import { ErrorBoundary } from './ErrorBoundary';
import { type RomMeta } from './romStore';
import { useConfirm } from './ConfirmModal';
import { CoverCard } from './CoverCard';
import { useRomList } from './hooks/useRomList';
import { useRomMutations } from './hooks/useRomMutations';

// Pull every .gba member out of a ZIP archive.
function extractGbaFromZip(zipBytes: Uint8Array): Array<{ filename: string; bytes: Uint8Array }> {
  const out: Array<{ filename: string; bytes: Uint8Array }> = [];
  const entries = unzipSync(zipBytes, {
    filter: (file) => file.name.toLowerCase().endsWith('.gba'),
  });
  for (const [path, bytes] of Object.entries(entries)) {
    const filename = path.split('/').pop() || path;
    out.push({ filename, bytes });
  }
  return out;
}

// / — full-page ROM library. Card grid with Hasheous metadata + cover
// art (LibRetro thumbnails). Click a card → /play/:romId.
export function LibraryPage() {
  const navigate = useNavigate();
  const { data: roms = [], isLoading } = useRomList();
  const { add, remove } = useRomMutations();
  const confirm = useConfirm();

  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<string[]>([]);
  const append = (msg: string) => setLog((p) => [...p, msg]);

  const handleFiles = async (files: FileList | File[]) => {
    setBusy(true);
    try {
      const arr = Array.from(files);
      const queue: Array<{ filename: string; bytes: Uint8Array }> = [];
      for (const file of arr) {
        const lower = file.name.toLowerCase();
        const raw = new Uint8Array(await file.arrayBuffer());
        if (lower.endsWith('.zip')) {
          try {
            const extracted = extractGbaFromZip(raw);
            if (extracted.length === 0) {
              append(`${file.name}: no .gba files inside`);
              continue;
            }
            queue.push(...extracted);
          } catch (e) {
            append(`${file.name}: zip read failed — ${(e as Error).message}`);
          }
        } else if (lower.endsWith('.gba')) {
          queue.push({ filename: file.name, bytes: raw });
        } else {
          append(`${file.name}: unsupported file type (.gba or .zip only)`);
        }
      }
      for (const { filename, bytes } of queue) {
        try {
          await add.mutateAsync({ filename, bytes });
          append(`added ${filename}`);
        } catch (e) {
          append(`add ${filename} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const onDeleteOne = (id: string, name: string) => {
    confirm.ask({
      title: 'Delete ROM',
      message: `Remove "${name}" from your library?\nThe save file stays — you can re-import the ROM later.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => { remove.mutate(id); },
    });
  };
  const onDeleteSelected = () => {
    if (selected.size === 0) return;
    const n = selected.size;
    confirm.ask({
      title: 'Delete selected',
      message: `Remove ${n} ROM${n === 1 ? '' : 's'} from your library? Save files stay intact.`,
      confirmLabel: `Delete ${n}`,
      danger: true,
      onConfirm: async () => {
        for (const id of selected) await remove.mutateAsync(id);
        setSelectMode(false);
        setSelected(new Set());
      },
    });
  };
  const onClearAll = () => {
    confirm.ask({
      title: 'Clear library',
      message: `Remove ALL ${roms.length} ROMs from your library? Save files stay intact.`,
      confirmLabel: 'Clear all',
      danger: true,
      onConfirm: async () => {
        for (const r of roms) await remove.mutateAsync(r.id);
      },
    });
  };
  const toggleSelected = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };
  const selectAll = () => {
    if (selected.size === roms.length) setSelected(new Set());
    else setSelected(new Set(roms.map((r: RomMeta) => r.id)));
  };

  return (
    <div className="w-full max-w-[720px] px-3 py-3">
      <header className="flex flex-wrap gap-2 justify-between items-baseline mb-3 pb-2 border-b border-[#2a2a30]">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold tracking-wider m-0">gba-recomp</h1>
          <span className="text-[10px] uppercase tracking-wider opacity-50">library</span>
        </div>
        {roms.length > 0 && (
          <button
            onClick={() => { setSelectMode(!selectMode); if (selectMode) setSelected(new Set()); }}
            className="text-[10px] uppercase tracking-wider opacity-70 hover:opacity-100 bg-transparent border-0 cursor-pointer"
          >{selectMode ? 'Cancel select' : 'Select'}</button>
        )}
      </header>

      <ErrorBoundary label="Library" variant="inline">
        <label
          className={`block border-2 border-dashed rounded-md p-5 text-center cursor-pointer mb-4 transition-colors ${
            dragging ? 'border-[#5060a0] bg-[#1c1c2a]' : 'border-[#2a2a30] hover:border-[#404050]'
          } ${busy ? 'opacity-50 pointer-events-none' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        >
          <input
            type="file"
            accept=".gba,.zip"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(e) => { if (e.target.files) { handleFiles(e.target.files); e.target.value = ''; } }}
          />
          <div className="text-xs opacity-80">
            {busy ? 'Importing…' : 'Drop a .gba or .zip ROM here, or tap to pick one'}
          </div>
          <div className="text-[10px] opacity-50 mt-1">
            Stored locally in your browser via IndexedDB — never uploaded anywhere
          </div>
        </label>

        {isLoading ? (
          <div className="py-12 text-center opacity-50 text-xs">Loading library…</div>
        ) : roms.length === 0 ? (
          <div className="py-12 text-center opacity-50 text-xs">
            No ROMs imported yet.<br />
            Drop a .gba file above to get started.
          </div>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {roms.map((rom: RomMeta) => (
              <CoverCard
                key={rom.id}
                rom={rom}
                selectMode={selectMode}
                selected={selected.has(rom.id)}
                onActivate={() => selectMode ? toggleSelected(rom.id) : navigate(`/play/${rom.id}`)}
                onDelete={(displayName) => onDeleteOne(rom.id, displayName)}
              />
            ))}
          </ul>
        )}

        {selectMode && roms.length > 0 && (
          <div className="mt-4 pt-3 border-t border-[#2a2a30] flex flex-wrap items-center justify-between gap-2 text-xs">
            <button
              onClick={selectAll}
              className="bg-transparent border-0 text-[#9a9aa6] cursor-pointer hover:text-white"
            >{selected.size === roms.length ? 'Deselect all' : 'Select all'}</button>
            <div className="flex gap-2 items-center">
              <span className="opacity-60 mr-2">{selected.size} selected</span>
              <button
                onClick={onDeleteSelected}
                disabled={selected.size === 0}
                className="btn-default text-red-300 hover:!bg-red-900/30"
              >Delete selected</button>
            </div>
          </div>
        )}

        {!selectMode && roms.length > 1 && (
          <div className="mt-4 pt-3 border-t border-[#2a2a30] flex justify-end">
            <button
              onClick={onClearAll}
              className="text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100 bg-transparent border-0 cursor-pointer text-red-300"
            >Clear entire library</button>
          </div>
        )}

        {log.length > 0 && (
          <div className="mt-4 pt-3 border-t border-[#2a2a30] text-[10px] opacity-50 font-mono space-y-0.5 max-h-32 overflow-y-auto">
            {log.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        )}
      </ErrorBoundary>

      <footer className="mt-6 pt-3 border-t border-[#2a2a30] flex justify-end text-[10px] opacity-50">
        <a
          href="https://github.com/ImLunaHey/gba-recomp/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:opacity-100 hover:text-[var(--color-accent)]"
        >Report an issue ↗</a>
      </footer>

      {confirm.node}
    </div>
  );
}

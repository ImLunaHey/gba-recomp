import { useEffect, useState } from 'react';
import { unzipSync } from 'fflate';
import { addRom, deleteRom, listRoms, type RomMeta } from './romStore';

// Pull every .gba member out of a ZIP archive. Returns an array of
// {filename, bytes} pairs so the import code can treat them like plain
// File uploads. Skips folder entries and any non-.gba members.
function extractGbaFromZip(zipBytes: Uint8Array): Array<{ filename: string; bytes: Uint8Array }> {
  const out: Array<{ filename: string; bytes: Uint8Array }> = [];
  // fflate's unzipSync returns { [path]: Uint8Array } synchronously.
  // For 16-32 MB ROMs in a zip this typically completes in 30-60 ms.
  const entries = unzipSync(zipBytes, {
    filter: (file) => file.name.toLowerCase().endsWith('.gba'),
  });
  for (const [path, bytes] of Object.entries(entries)) {
    // Strip leading directory components from the in-zip path.
    const filename = path.split('/').pop() || path;
    out.push({ filename, bytes });
  }
  return out;
}

interface Props {
  open: boolean;
  currentId: string | null;
  onClose: () => void;
  onSelect: (meta: RomMeta) => void;
  onAppend: (msg: string) => void;
}

export function RomLibrary({ open, currentId, onClose, onSelect, onAppend }: Props) {
  const [roms, setRoms] = useState<RomMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const refresh = async () => setRoms(await listRoms());

  useEffect(() => { if (open) refresh(); }, [open]);

  // Normalize incoming files: ZIPs get extracted to their constituent
  // .gba members, raw .gba files pass through, anything else is rejected.
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
              onAppend(`${file.name}: no .gba files inside`);
              continue;
            }
            queue.push(...extracted);
          } catch (e) {
            onAppend(`${file.name}: zip extraction failed (${(e as Error).message})`);
          }
        } else if (lower.endsWith('.gba')) {
          queue.push({ filename: file.name, bytes: raw });
        } else {
          onAppend(`skipped ${file.name} (need .gba or .zip)`);
        }
      }
      for (const { filename, bytes } of queue) {
        if (bytes.length < 0xC0) {
          onAppend(`skipped ${filename} (too small to be a GBA ROM)`);
          continue;
        }
        const meta = await addRom(filename, bytes);
        onAppend(`imported ${meta.title || meta.code} (${(bytes.length / (1024 * 1024)).toFixed(1)} MB)`);
      }
      await refresh();
    } catch (e) {
      onAppend(`ROM import failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string, title: string) => {
    if (!confirm(`Remove "${title}" from your library?`)) return;
    await deleteRom(id);
    onAppend(`removed ${title}`);
    await refresh();
  };

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000]"
      onClick={onClose}
    >
      <div
        className="bg-[#14141a] border border-[#2a2a30] rounded-lg p-4 w-[640px] max-h-[80vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-3 pb-2 border-b border-[#2a2a30]">
          <div className="text-sm font-bold tracking-wider">ROM Library</div>
          <button
            onClick={onClose}
            className="bg-transparent border-0 text-[#d8d8e0] text-lg cursor-pointer px-2 hover:text-white"
          >×</button>
        </div>

        <label
          className={`block border-2 border-dashed rounded-md p-6 text-center cursor-pointer mb-3 transition-colors ${
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
            {busy ? 'Importing…' : 'Drop a .gba or .zip ROM here, or click to pick one'}
          </div>
          <div className="text-[10px] opacity-50 mt-1">
            Stored locally in your browser via IndexedDB — never uploaded anywhere
          </div>
        </label>

        {roms.length === 0 ? (
          <div className="py-8 text-center opacity-50 text-xs">
            No ROMs imported yet.<br />
            Drop a .gba file above to get started.
          </div>
        ) : (
          <ul className="space-y-1">
            {roms.map((rom) => (
              <li
                key={rom.id}
                className={`flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors ${
                  rom.id === currentId
                    ? 'bg-[#2a3a5a] border border-[#4060a0]'
                    : 'bg-[#1c1c22] border border-[#2a2a30] hover:bg-[#24242a]'
                }`}
                onClick={() => onSelect(rom)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{rom.title || rom.filename}</div>
                  <div className="text-[10px] opacity-60 truncate">
                    {rom.code} · {(rom.size / (1024 * 1024)).toFixed(1)} MB · {rom.filename}
                  </div>
                </div>
                {rom.id === currentId && (
                  <div className="text-[10px] text-[#9be7ff] tracking-wider">PLAYING</div>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(rom.id, rom.title || rom.filename); }}
                  className="bg-transparent border-0 text-[#9a9aa6] text-sm cursor-pointer px-2 hover:text-red-400"
                  title="Remove from library"
                >🗑</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

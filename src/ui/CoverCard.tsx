import { type RomMeta } from './romStore';
import { CoverImage } from './CoverImage';
import { useRomMd5 } from './hooks/useRomMd5';
import { useHasheousMeta } from './hooks/useHasheousMeta';

// A single library card. Owns its own query chain: rom → md5 →
// Hasheous metadata → cover URL (the actual cover URL probing lives
// inside CoverImage via useCoverUrl). Keeping this per-card means
// React Query can dedup + cache each step independently and the
// LibraryPage doesn't have to choreograph anything.

interface Props {
  rom: RomMeta;
  selectMode: boolean;
  selected: boolean;
  onActivate: () => void;
  onDelete: (displayName: string) => void;
}

export function CoverCard({ rom, selectMode, selected, onActivate, onDelete }: Props) {
  const md5Query = useRomMd5(rom.id, rom.md5);
  const metaQuery = useHasheousMeta(md5Query.data);
  const m = metaQuery.data ?? null;

  const displayName = m?.name || rom.title || rom.filename;
  const year = m?.year ?? null;
  const subtitleParts: string[] = [rom.code];
  if (year) subtitleParts.push(year);
  subtitleParts.push(`${(rom.size / (1024 * 1024)).toFixed(0)}M`);

  return (
    <li
      className={`group rounded-md transition-colors ${
        selectMode
          ? selected
            ? 'ring-2 ring-[#5060a0]'
            : 'opacity-80 hover:opacity-100'
          : 'cursor-pointer hover:scale-[1.02] hover:z-10 transition-transform'
      }`}
      onClick={onActivate}
    >
      <div className="relative">
        <CoverImage
          title={displayName}
          subtitle={year || rom.code}
          thumbnails={m?.thumbnails ?? []}
        />
        {selectMode && (
          <input
            type="checkbox"
            checked={selected}
            readOnly
            className="absolute top-1 left-1 w-4 h-4 accent-[#5060a0] pointer-events-none"
          />
        )}
        {!selectMode && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(displayName); }}
            className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded bg-black/60 text-[#9a9aa6] text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 hover:!text-red-400 transition-opacity"
            title="Remove from library"
            aria-label="Remove"
          >🗑</button>
        )}
      </div>
      <div className="min-w-0 mt-1.5 px-0.5">
        <div className="text-[11px] font-medium leading-tight line-clamp-2" title={displayName}>{displayName}</div>
        <div className="text-[9px] opacity-50 truncate" title={`${rom.filename} · ${m?.platform || 'GBA'}`}>
          {subtitleParts.join(' · ')}
        </div>
      </div>
    </li>
  );
}

import { useEffect, useRef } from 'react';

interface Props { lines: string[]; }

export function LogPane({ lines }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <div
      ref={ref}
      className="w-[720px] h-[120px] overflow-auto bg-[#0e0e12] border border-[#1c1c20] p-2 text-[11px] text-[var(--color-muted)] whitespace-pre-wrap"
    >
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

import { CartArt } from './CartArt';
import { useCoverUrl } from './hooks/useCoverUrl';

// Renders the LibRetro thumbnail for a game (probed via useCoverUrl),
// falling back to the stylized CartArt placeholder while the probe is
// in flight or if every candidate URL 404'd.

interface Props {
  title: string;
  subtitle?: string;
  thumbnails: string[];
  className?: string;
}

export function CoverImage({ title, subtitle, thumbnails, className }: Props) {
  const { data: resolved } = useCoverUrl(title, thumbnails);

  if (resolved) {
    return (
      <div
        className={`relative overflow-hidden rounded-md bg-[#0a0a0c] ${className ?? ''}`}
        style={{ aspectRatio: '1 / 1' }}
      >
        {/* object-contain so heterogeneous LibRetro thumbnails (some
            512×512 padded, some weird like 256×229) render whole
            instead of getting cropped to fit the card. */}
        <img
          src={resolved}
          alt={title}
          loading="lazy"
          className="absolute inset-0 w-full h-full object-contain"
        />
      </div>
    );
  }
  return <CartArt title={title} subtitle={subtitle} className={className} />;
}

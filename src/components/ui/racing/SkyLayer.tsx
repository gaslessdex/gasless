import type { Theme } from '../../../types/app';

const stars = Array.from({ length: 38 }, (_, index) => ({
  left: `${(index * 37 + 11) % 97}%`,
  top: `${7 + ((index * 23) % 43)}%`,
  opacity: 0.24 + (index % 5) * 0.11,
  size: index % 9 === 0 ? 2 : 1,
}));

export function SkyLayer({ theme }: { theme: Theme }) {
  return (
    <div className={`racing-sky racing-sky--${theme}`} aria-hidden="true">
      <div className="racing-sky__cloud racing-sky__cloud--one" />
      <div className="racing-sky__cloud racing-sky__cloud--two" />
      <div className="racing-sky__stars">
        {stars.map((star, index) => <i key={index} style={{ left: star.left, top: star.top, opacity: star.opacity, width: star.size, height: star.size }} />)}
      </div>
      <div className="racing-sky__haze" />
    </div>
  );
}

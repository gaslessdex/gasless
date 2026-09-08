import { useEffect, useRef, useState } from 'react';

const CLOSE_DELAY_MS = 150;
const SHEET_MENU_QUERY = '(max-width: 1024px), (hover: none), (pointer: coarse)';

export function SteeringWheel({ onFaqSelect, onMobileMenu }: { onFaqSelect: () => void; onMobileMenu: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const pointerPoint = useRef({ x: 0, y: 0 });

  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const usesSheetMenu = () => matchMedia(SHEET_MENU_QUERY).matches;
  const openMenu = () => {
    cancelClose();
    setMenuOpen(true);
  };
  const scheduleClose = (event?: React.PointerEvent) => {
    cancelClose();
    if (event) pointerPoint.current = { x: event.clientX, y: event.clientY };
    closeTimer.current = window.setTimeout(() => {
      const { x, y } = pointerPoint.current;
      const remainsOnControl = document.elementsFromPoint(x, y).some((element) => element.closest('.wheel-hub,.cockpit-nav'));
      if (!remainsOnControl) setMenuOpen(false);
    }, CLOSE_DELAY_MS);
  };

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      cancelClose();
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return (
    <div ref={root} className={`steering-control${menuOpen ? ' is-menu-open' : ''}`}>
      <div className="steering-wheel" aria-label="Steering wheel">
        <svg viewBox="0 0 600 600" role="img" aria-label="Classic three-spoke GASLESS steering wheel">
          <defs>
            <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--wheel-hi)"/><stop offset=".22" stopColor="var(--wheel-mid)"/><stop offset=".62" stopColor="var(--wheel-low)"/><stop offset="1" stopColor="var(--wheel-hi)"/></linearGradient>
            <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--metal-hi)"/><stop offset=".5" stopColor="var(--metal)"/><stop offset="1" stopColor="var(--metal-low)"/></linearGradient>
            <pattern id="grip" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(24)"><rect width="12" height="12" fill="transparent"/><path d="M0 1h12" stroke="var(--grip-line)" strokeWidth="2"/></pattern>
            <mask id="side-grips"><rect width="600" height="600" fill="black"/><path d="M114 460 A244 244 0 0 1 114 140 M486 140 A244 244 0 0 1 486 460" fill="none" stroke="white" strokeWidth="74" strokeLinecap="round"/></mask>
          </defs>
          <circle className="wheel-shadow" cx="300" cy="300" r="251" />
          <circle className="wheel-rim-outer" cx="300" cy="300" r="244" />
          <circle className="wheel-rim" cx="300" cy="300" r="244" />
          <circle className="wheel-rim-highlight" cx="300" cy="300" r="220" />
          <rect width="600" height="600" fill="url(#grip)" mask="url(#side-grips)" opacity=".78" />
          <g className="wheel-spokes">
            <path d="M268 283 120 205 102 249 244 323Z" />
            <path d="M332 283 480 205 498 249 356 323Z" />
            <path d="M276 332 262 515 338 515 324 332Z" />
            <path className="spoke-inset" d="M250 294 136 232 130 247 251 317ZM350 294 464 232 470 247 349 317ZM289 337 281 494 319 494 311 337Z" />
          </g>
          <circle className="hub-bezel" cx="300" cy="310" r="78" />
          <circle className="hub-plate" cx="300" cy="310" r="61" />
          {[0, 60, 120, 180, 240, 300].map((angle) => {
            const radians = angle * Math.PI / 180;
            return <circle key={angle} className="hub-bolt" cx={300 + Math.cos(radians) * 48} cy={310 + Math.sin(radians) * 48} r="5" />;
          })}
        </svg>
      </div>
      <nav
        id="cockpit-navigation"
        className="cockpit-nav"
        aria-label="GASLESS navigation"
        aria-hidden={!menuOpen}
        onPointerEnter={() => { if (matchMedia('(hover: hover)').matches) openMenu(); }}
        onPointerLeave={scheduleClose}
        onClick={(event) => {
          if (matchMedia('(hover: none)').matches && event.target === event.currentTarget) setMenuOpen(false);
        }}
      >
        <div className="cockpit-nav__inner">
          <a className="cockpit-nav__logo" href="#home" aria-label="GASLESS home" onClick={() => setMenuOpen(false)} tabIndex={menuOpen ? 0 : -1}>
            <span className="cockpit-nav__brand">GASLESS</span>
          </a>
          <a className="cockpit-nav__text" href="https://github.com/gaslessdex" target="_blank" rel="noreferrer" tabIndex={menuOpen ? 0 : -1}>GITHUB</a>
          <a className="cockpit-nav__text" href="https://x.com/gaslessdex" target="_blank" rel="noreferrer" tabIndex={menuOpen ? 0 : -1}>TWITTER</a>
          <button className="cockpit-nav__text" type="button" onClick={() => { setMenuOpen(false); onFaqSelect(); }} tabIndex={menuOpen ? 0 : -1}>FAQ</button>
          <a className="cockpit-nav__token" href="#gasless-token" onClick={() => setMenuOpen(false)} tabIndex={menuOpen ? 0 : -1}><span>GASLESS TOKEN</span></a>
        </div>
      </nav>
      <button
        className="wheel-hub"
        type="button"
        aria-expanded={menuOpen}
        aria-controls="cockpit-navigation"
        aria-label="Toggle GASLESS navigation"
        onPointerEnter={() => { if (matchMedia('(hover: hover)').matches) openMenu(); }}
        onPointerLeave={scheduleClose}
        onFocus={() => { if (!usesSheetMenu()) openMenu(); }}
        onClick={(event) => {
          if (usesSheetMenu()) {
            setMenuOpen(false);
            event.currentTarget.blur();
            onMobileMenu();
          } else openMenu();
        }}
      ><span>G</span></button>
    </div>
  );
}

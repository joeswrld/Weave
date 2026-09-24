/**
 * The WVE coin badge.
 *
 * The mark is not decorative — it encodes what Weave actually is (see
 * docs/architecture.md's thesis and packages/protocol's peer-gossip
 * design): independent peers — ordinary browser tabs, no dedicated
 * hardware — that connect directly to each other over WebRTC/WebSockets
 * and weave themselves into one chain. So the glyph is three separate
 * strands that cross through a shared center: three peers, one weave.
 * Where they cross is drawn as a small bright node, the same way the
 * protocol's own diagrams show peers meeting at a shared point rather
 * than routing through a central server.
 *
 * Rendered as a minted coin (domed face, brushed rim, bevel, glow) so it
 * reads as a premium asset, not just a flat logotype.
 */
interface WeaveCoinIconProps {
  /** Pixel size (width and height); the icon is always a perfect circle. */
  size?: number;
  className?: string;
}

let uid = 0;

export function WeaveCoinIcon({ size = 28, className }: WeaveCoinIconProps) {
  // Unique per-instance gradient/filter ids so multiple icons on one page
  // (list rows, headers, etc.) never clash.
  const id = `wve-coin-${++uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="WVE"
    >
      <defs>
        {/* Rim: a warm-to-cool sweep so the ring reads as brushed metal, not flat paint */}
        <linearGradient id={`${id}-rim`} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#8ff5da" />
          <stop offset="45%" stopColor="#5ee6c4" />
          <stop offset="100%" stopColor="#2c9d84" />
        </linearGradient>

        {/* Face: near-black with a faint lift top-left, like light grazing a domed disc */}
        <radialGradient id={`${id}-face`} cx="34%" cy="28%" r="80%">
          <stop offset="0%" stopColor="#1b2027" />
          <stop offset="55%" stopColor="#101317" />
          <stop offset="100%" stopColor="#0a0c0f" />
        </radialGradient>

        {/* Three distinct strand colors so each "peer" reads as its own thread,
            even though they're the same accent family */}
        <linearGradient id={`${id}-strand-a`} x1="6" y1="11" x2="26" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a8fbe6" />
          <stop offset="100%" stopColor="#5ee6c4" />
        </linearGradient>
        <linearGradient id={`${id}-strand-b`} x1="26" y1="11" x2="6" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7fe0ff" />
          <stop offset="100%" stopColor="#5ee6c4" />
        </linearGradient>
        <linearGradient id={`${id}-strand-c`} x1="16" y1="7" x2="16" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#c8fff0" />
          <stop offset="100%" stopColor="#4fd6b3" />
        </linearGradient>

        <filter id={`${id}-glow`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Outer rim (slightly larger disc showing behind the face = beveled edge) */}
      <circle cx="16" cy="16" r="16" fill={`url(#${id}-rim)`} />

      {/* Face, inset from the rim so a ~1.1px metal edge shows all the way around */}
      <circle cx="16" cy="16" r="14.9" fill={`url(#${id}-face)`} />

      {/* Inner bevel line for a second, subtler ring of depth just inside the face */}
      <circle cx="16" cy="16" r="13.4" fill="none" stroke="#ffffff14" strokeWidth="0.6" />

      {/* Three strands (peers) weaving through one shared center — the actual
          network topology, not a decorative pattern */}
      <g filter={`url(#${id}-glow)`} fill="none" strokeLinecap="round">
        <path d={`M7 12 Q16 16 25 12`} stroke={`url(#${id}-strand-a)`} strokeWidth="1.8" />
        <path d={`M7 20 Q16 16 25 20`} stroke={`url(#${id}-strand-b)`} strokeWidth="1.8" />
        <path d={`M16 7 Q16 16 16 25`} stroke={`url(#${id}-strand-c)`} strokeWidth="1.8" />
      </g>

      {/* The node: where the three peers meet and gossip becomes one chain */}
      <circle cx="16" cy="16" r="2.1" fill="#0a0c0f" />
      <circle cx="16" cy="16" r="2.1" fill="none" stroke="#eafffa" strokeWidth="0.9" />
      <circle cx="16" cy="16" r="0.9" fill="#eafffa" filter={`url(#${id}-glow)`} />

      {/* Specular highlight arc, top-left, to sell the "domed coin" read */}
      <path
        d="M8.5 8.2 A 12 12 0 0 1 19.5 5.1"
        stroke="#ffffff2a"
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
import { useId } from "react";

/** Pepperoni positions as [angle in degrees from 12 o'clock, distance as a share of the radius]. */
const toppings: Array<[number, number]> = [
  [18, 0.62], [52, 0.36], [80, 0.7], [118, 0.5], [150, 0.74], [178, 0.32], [205, 0.66],
  [238, 0.45], [268, 0.72], [300, 0.38], [328, 0.68], [350, 0.3], [100, 0.18], [260, 0.2]
];

function polar(cx: number, cy: number, radius: number, degrees: number): [number, number] {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
}

/** The covered wedge, drawn clockwise from 12 o'clock. */
export function wedgePath(cx: number, cy: number, radius: number, percent: number): string | null {
  if (percent <= 0) return null;
  if (percent >= 100) {
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`;
  }
  const [endX, endY] = polar(cx, cy, radius, (percent / 100) * 360);
  return `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${percent > 50 ? 1 : 0} 1 ${endX} ${endY} Z`;
}

export function coverageTone(percent: number | null | undefined): "critical" | "poor" | "fair" | "good" | "none" {
  if (percent === null || percent === undefined) return "none";
  return percent < 25 ? "critical" : percent < 50 ? "poor" : percent < 80 ? "fair" : "good";
}

/**
 * A coverage pie dressed as a pizza: the covered share has its toppings, the
 * rest is bare dough. Eight cut lines make quarters and eighths easy to read.
 */
export function Pizza({ percent, size = 120, label }: { percent: number | null; size?: number; label: string }) {
  const clipId = useId();
  const center = 50;
  const crust = 46;
  const radius = 40;
  const wedge = percent === null ? null : wedgePath(center, center, radius, percent);
  return (
    <svg
      className={`pizza pizza-${coverageTone(percent)}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label}
    >
      <circle className="pizza-crust" cx={center} cy={center} r={crust} />
      <circle className="pizza-dough" cx={center} cy={center} r={radius} />
      {wedge && (
        <>
          <clipPath id={clipId}><path d={wedge} /></clipPath>
          <g clipPath={`url(#${clipId})`}>
            <circle className="pizza-sauce" cx={center} cy={center} r={radius} />
            <circle className="pizza-cheese" cx={center} cy={center} r={radius - 3} />
            {toppings.map(([angle, distance]) => {
              const [x, y] = polar(center, center, (radius - 6) * distance, angle);
              return <circle key={`${angle}-${distance}`} className="pizza-topping" cx={x} cy={y} r={4.2} />;
            })}
          </g>
        </>
      )}
      {Array.from({ length: 4 }, (_, index) => {
        const [x1, y1] = polar(center, center, radius, index * 45);
        const [x2, y2] = polar(center, center, radius, index * 45 + 180);
        return <line key={index} className="pizza-cut" x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
    </svg>
  );
}

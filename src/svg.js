const COLORS = {
  bg: "#0d1117",
  border: "#30363d",
  text: "#c9d1d9",
  subtle: "#8b949e",
  levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfWeekSundayUtc(date) {
  const day = date.getUTCDay();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
}

function addUtcDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function rollingWindowStartUtc(today, months) {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  start.setUTCMonth(start.getUTCMonth() - months);
  start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

function levelForCount(count, thresholds) {
  if (count <= 0) {
    return 0;
  }

  let level = 0;
  for (let index = 0; index < thresholds.length; index += 1) {
    if (count >= thresholds[index]) {
      level = index + 1;
    }
  }

  return Math.min(level, 4);
}

function monthLabelPositions(days) {
  const seen = new Set();
  const labels = [];

  days.forEach((date, dayIndex) => {
    if (date.getUTCDate() > 7) {
      return;
    }

    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    const week = Math.floor(dayIndex / 7);
    labels.push({ week, label: MONTHS[date.getUTCMonth()] });
  });

  return labels;
}

export function buildActivitySvg({
  username,
  months,
  thresholds,
  repos,
  commits,
  pullRequests,
  totalContributions,
  stars,
  dayMap,
  generatedAt,
}) {
  const today = startOfUtcDay(new Date());
  const rangeStart = rollingWindowStartUtc(today, months);
  const firstCellDate = startOfWeekSundayUtc(rangeStart);

  const days = [];
  for (let current = firstCellDate; current <= today; current = addUtcDays(current, 1)) {
    days.push(current);
  }

  while (days.length % 7 !== 0) {
    const last = days[days.length - 1];
    days.push(addUtcDays(last, 1));
  }

  const weeks = days.length / 7;
  const cell = 11;
  const gap = 3;
  const gridX = 58;
  const gridY = 88;

  const width = gridX + weeks * (cell + gap) + 24;
  const height = 208;

  const monthLabels = monthLabelPositions(days);

  const cells = days
    .map((date, index) => {
      const week = Math.floor(index / 7);
      const day = index % 7;
      const x = gridX + week * (cell + gap);
      const y = gridY + day * (cell + gap);
      const dateKey = utcDateString(date);
      const count = dayMap.get(dateKey) || 0;
      const level = levelForCount(count, thresholds);
      const fill = COLORS.levels[level];

      return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${fill}"><title>${dateKey}: ${count} contributions (commits + PRs)</title></rect>`;
    })
    .join("");

  const monthText = monthLabels
    .map(
      (month) =>
        `<text x="${gridX + month.week * (cell + gap)}" y="76" fill="${COLORS.subtle}" font-size="10" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial">${month.label}</text>`,
    )
    .join("");

  const dayLabels = DAYS.map((label, index) => {
    if (index % 2 === 1) {
      return "";
    }
    const y = gridY + index * (cell + gap) + 9;
    return `<text x="18" y="${y}" fill="${COLORS.subtle}" font-size="10" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial">${label}</text>`;
  }).join("");

  const legendX = width - 162;
  const legend = [0, 1, 2, 3, 4]
    .map((level, idx) => {
      const x = legendX + idx * 14;
      return `<rect x="${x}" y="186" width="10" height="10" rx="2" ry="2" fill="${COLORS.levels[level]}"/>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">GitHub activity for ${escapeXml(username)}</title>
  <desc id="desc">Contribution stats and commit/PR activity heatmap.</desc>
  <rect x="0" y="0" width="${width}" height="${height}" rx="10" ry="10" fill="${COLORS.bg}" stroke="${COLORS.border}" />

  <text x="16" y="28" fill="${COLORS.text}" font-size="16" font-weight="600" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial">${escapeXml(username)} · GitHub activity</text>
  <text x="16" y="48" fill="${COLORS.text}" font-size="12" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial">Repos: ${repos}  •  Commits: ${commits}  •  PRs: ${pullRequests}  •  Stars: ${stars}${totalContributions != null ? `  •  Total contributions: ${totalContributions}` : ""}</text>
  <text x="16" y="66" fill="${COLORS.subtle}" font-size="10" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial">Contribution heatmap</text>

  ${monthText}
  ${dayLabels}
  ${cells}

  <text x="${legendX - 48}" y="195" fill="${COLORS.subtle}" font-size="10" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial">Less</text>
  ${legend}
  <text x="${legendX + 74}" y="195" fill="${COLORS.subtle}" font-size="10" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial">More</text>

  <text x="16" y="194" fill="${COLORS.subtle}" font-size="10" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial">Updated: ${escapeXml(generatedAt)}</text>
</svg>`;
}

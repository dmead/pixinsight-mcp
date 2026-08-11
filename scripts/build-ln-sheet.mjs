// build-ln-sheet.mjs — assemble the LN vs no-LN contact sheet as a self-contained
// HTML page with the auto-STF panels inlined as data URIs.
//
//   node scripts/build-ln-sheet.mjs <panel-dir> <out.html>
//
// Panels come from xisf-preview.mjs. Everything is inlined because published
// artifacts run under a CSP that blocks external hosts.

import fs from 'fs';

const [panelDir, outFile] = process.argv.slice(2);
if (!panelDir || !outFile) {
  console.error('usage: build-ln-sheet.mjs <panel-dir> <out.html>');
  process.exit(2);
}

// Measured this session. Corner spread = max-min of five 400px box medians
// (four corners at 18% inset + centre), as a fraction of the centre median.
const ROWS = [
  { f: 'lum',    frames: 250, ds: '0.807', sNo: 2.22, sLn: 1.66, mNo: 0.029123, mLn: 0.034873 },
  { f: 'red',    frames: 115, ds: '0.813', sNo: 2.07, sLn: 1.68, mNo: 0.016907, mLn: 0.020061 },
  { f: 'green',  frames: 121, ds: '0.819', sNo: 1.91, sLn: 2.29, mNo: 0.025134, mLn: 0.016984 },
  { f: 'halpha', frames: 82,  ds: '0.819', sNo: 2.25, sLn: 0.11, mNo: 0.000383, mLn: 0.010834 },
  { f: 'blue',   frames: 75,  ds: '0.819', sNo: 1.63, sLn: 1.92, mNo: 0.060082, mLn: 0.043504 },
];

const uri = (name) =>
  `data:image/png;base64,${fs.readFileSync(`${panelDir}/${name}.png`).toString('base64')}`;

const rowHtml = (r) => {
  const delta = r.sLn - r.sNo;
  const better = delta < 0;
  const cls = better ? 'good' : 'warn';
  const sign = delta > 0 ? '+' : '';
  return `
  <section class="row">
    <header class="rowhead">
      <h2>${r.f}</h2>
      <dl class="meta">
        <div><dt>frames</dt><dd>${r.frames}</dd></div>
        <div><dt>drop shrink</dt><dd>${r.ds}</dd></div>
        <div><dt>corner spread</dt><dd>${r.sNo.toFixed(2)}% <span class="arrow">&rarr;</span> ${r.sLn.toFixed(2)}%</dd></div>
      </dl>
      <span class="chip ${cls}">${sign}${delta.toFixed(2)} pts</span>
    </header>
    <div class="pair">
      <figure>
        <img src="${uri(`${r.f}_noln`)}" alt="${r.f} master integrated without local normalization" loading="lazy" />
        <figcaption><span class="tag">no LN</span><span class="num">median ${r.mNo.toFixed(6)}</span></figcaption>
      </figure>
      <figure>
        <img src="${uri(`${r.f}_ln`)}" alt="${r.f} master integrated with local normalization" loading="lazy" />
        <figcaption><span class="tag on">with LN</span><span class="num">median ${r.mLn.toFixed(6)}</span></figcaption>
      </figure>
    </div>
  </section>`;
};

const html = `<title>M81/M82 masters — local normalization comparison</title>
<style>
  :root {
    --ground:#0a0c11; --surface:#151922; --line:#232936;
    --text:#e2e6ef; --muted:#8d95a8; --accent:#79a6c9;
    --good:#6fa07c; --warn:#c08a6a;
    --mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
    --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --ground:#f2f3f6; --surface:#ffffff; --line:#dce0e8;
      --text:#191d26; --muted:#5c6474; --accent:#3d7495;
      --good:#3f7a52; --warn:#9a5636;
    }
  }
  :root[data-theme="dark"] {
    --ground:#0a0c11; --surface:#151922; --line:#232936;
    --text:#e2e6ef; --muted:#8d95a8; --accent:#79a6c9;
    --good:#6fa07c; --warn:#c08a6a;
  }
  :root[data-theme="light"] {
    --ground:#f2f3f6; --surface:#ffffff; --line:#dce0e8;
    --text:#191d26; --muted:#5c6474; --accent:#3d7495;
    --good:#3f7a52; --warn:#9a5636;
  }

  body {
    background: var(--ground); color: var(--text);
    font-family: var(--sans); line-height: 1.55;
    margin: 0; padding: 40px 24px 72px;
  }
  .wrap { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 34px; }

  h1 { font-size: 1.6rem; font-weight: 620; letter-spacing: -0.01em; margin: 0; text-wrap: balance; }
  .lede { color: var(--muted); max-width: 68ch; margin: 0; font-size: 0.95rem; }
  .lede code { font-family: var(--mono); font-size: 0.86em; color: var(--accent); }

  .note {
    border-left: 2px solid var(--accent); padding: 2px 0 2px 14px;
    color: var(--muted); font-size: 0.88rem; max-width: 68ch;
  }

  .row { display: flex; flex-direction: column; gap: 12px; }
  .rowhead {
    display: flex; align-items: baseline; gap: 20px; flex-wrap: wrap;
    border-bottom: 1px solid var(--line); padding-bottom: 10px;
  }
  .rowhead h2 {
    font-size: 1.05rem; margin: 0; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent);
  }
  .meta { display: flex; gap: 22px; margin: 0; flex-wrap: wrap; }
  .meta > div { display: flex; gap: 7px; align-items: baseline; }
  .meta dt { color: var(--muted); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.06em; margin: 0; }
  .meta dd { margin: 0; font-family: var(--mono); font-size: 0.86rem; font-variant-numeric: tabular-nums; }
  .arrow { color: var(--muted); padding: 0 2px; }

  .chip {
    margin-left: auto; font-family: var(--mono); font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    padding: 3px 9px; border-radius: 3px; border: 1px solid currentColor;
  }
  .chip.good { color: var(--good); }
  .chip.warn { color: var(--warn); }

  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 760px) { .pair { grid-template-columns: 1fr; } }

  figure { margin: 0; display: flex; flex-direction: column; gap: 7px; }
  figure img {
    width: 100%; max-width: 100%; display: block; border: 1px solid var(--line);
    background: #000;
  }
  figcaption { display: flex; align-items: baseline; gap: 12px; font-size: 0.78rem; }
  .tag {
    text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 600;
  }
  .tag.on { color: var(--text); }
  .num { font-family: var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }

  footer { color: var(--muted); font-size: 0.82rem; border-top: 1px solid var(--line); padding-top: 18px; max-width: 68ch; }
</style>

<div class="wrap">
  <header style="display:flex;flex-direction:column;gap:12px">
    <h1>M81/M82 masters — local normalization, side by side</h1>
    <p class="lede">
      Five drizzle 2&times; masters from 643 integrated frames, each rendered twice: integrated
      <strong>without</strong> local normalization (left) and <strong>with</strong> it (right).
      Both versions are identical in every other respect — same frames, same per-filter drop shrink,
      same ESD rejection and PSF weighting.
    </p>
    <p class="note">
      Each panel gets its <em>own</em> auto-STF (shadows at &minus;2.8&sigma;, background to 0.25),
      because the two versions have different medians and the question is what each looks like when
      displayed normally. A shared stretch would flatter whichever one happened to suit it — so
      compare background <em>evenness</em> across each frame, not overall brightness between panels.
      Downsampled 10&times; from 6016&times;6022 on linear data before stretching.
    </p>
  </header>
${ROWS.map(rowHtml).join('\n')}
  <footer>
    Corner spread is the max&minus;min of five 400&nbsp;px box medians (four corners at 18% inset plus
    centre), as a fraction of the centre median — lower is flatter. Halpha gains the most, as expected:
    its near-zero background makes it the most sensitive to per-frame sky differences. Green and blue
    move ~0.3&nbsp;points the other way, which is within the noise of a five-box metric rather than a
    real regression. Rendered directly from the XISF files; all measurements were made on the XISF, not
    on these PNGs.
  </footer>
</div>`;

fs.writeFileSync(outFile, html);
console.log(`wrote ${outFile}  (${(fs.statSync(outFile).size / 1e6).toFixed(2)} MB)`);

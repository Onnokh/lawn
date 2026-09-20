/**
 * Build the artwork the client downloads.
 *
 * `art/` holds the paintings at the size they were made. Nothing there is
 * served: a frame drawn at 2172 pixels across is shown 540 pixels wide, and
 * sending the other 1632 to every visitor buys nothing anybody can see.
 *
 * This writes each one into `public/assets/` at twice the largest box it is
 * ever drawn in — twice, so it still looks painted on a retina screen — and in
 * WebP, which is what a painting with soft edges wants. The alpha stays
 * lossless, because every one of these is a frame with a hole in it and a
 * ragged edge would show against the grass.
 *
 *     node scripts/build-assets.mjs
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { minimapFrame } from './make-minimap-frame.mjs';

const ART = 'art';
const OUT = 'public/assets';

/**
 * How wide each painting is written, and why. The number is twice the widest
 * the client ever draws it — three times for the smallest, where the whole
 * file is a few kilobytes and the headroom is free.
 *
 * A painting is never made taller or shorter in proportion. `world-quest-header`
 * is drawn stretched to its box, and changing its shape here would change how
 * much the browser stretches it.
 */
const PLATES = [
  // #quest-toggle: width min(500px, ...).
  { name: 'achievement-board-portrait', width: 1000 },
  // #award-toast: width min(540px, 94vw).
  { name: 'achievement-lawn-frame', width: 1080 },
  // #field-banner: width min(92vw, 700px).
  { name: 'field-entry-banner', width: 1400 },
  // #world-quests h2: a 260px box, stretched to fit. Three times over.
  { name: 'world-quest-header', width: 780 },
];

/**
 * The minimap is the one that is not written down small. It is drawn into the
 * big map, which runs to 1100 points across and so 2200 pixels on a retina
 * screen — more than the painting has. It is written at the size it was made.
 */
const MINIMAP_WIDTH = null;

const QUALITY = 82;

const kb = (n) => `${(n / 1024).toFixed(0)}K`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  let before = 0, after = 0;
  const say = async (name, source, written) => {
    const was = (await stat(source)).size;
    const now = (await stat(`${OUT}/${name}`)).size;
    before += was;
    after += now;
    console.log(`  ${name.padEnd(34)} ${kb(was).padStart(6)} -> ${kb(now).padStart(6)}  (${written})`);
  };

  for (const { name, width } of PLATES) {
    const source = `${ART}/${name}.png`;
    const image = sharp(source);
    const { width: native } = await image.metadata();
    // Never make a painting bigger than it was painted.
    const target = Math.min(width, native);
    await image
      .resize({ width: target, withoutEnlargement: true })
      .webp({ quality: QUALITY, alphaQuality: 100, effort: 6 })
      .toFile(`${OUT}/${name}.webp`);
    await say(`${name}.webp`, source, `${native} -> ${target} wide`);
  }

  // The frame and its mask are cut from one painting, so they are the same
  // shape by construction. The mask is written lossless: it is the alpha that
  // decides what the map shows through, and a guess at it is a torn edge.
  const { frame, opening, info, removed } = await minimapFrame(`${ART}/quest-card.png`);
  const raw = { raw: info };
  const size = MINIMAP_WIDTH ? { width: MINIMAP_WIDTH } : { width: info.width };
  await sharp(frame, raw).resize(size)
    .webp({ quality: QUALITY, alphaQuality: 100, effort: 6 })
    .toFile(`${OUT}/minimap-frame.webp`);
  await sharp(opening, raw).resize(size)
    .webp({ lossless: true, effort: 6 })
    .toFile(`${OUT}/minimap-opening.webp`);
  await say('minimap-frame.webp', `${ART}/quest-card.png`, `${info.width} wide, ${removed} inset pixels cut`);
  const mask = (await stat(`${OUT}/minimap-opening.webp`)).size;
  after += mask;
  console.log(`  ${'minimap-opening.webp'.padEnd(34)} ${''.padStart(6)}    ${kb(mask).padStart(6)}  (lossless mask)`);

  const served = (await readdir(OUT)).length;
  console.log(`\n${served} files, ${kb(before)} of paintings written as ${kb(after)}.`);
}

await main();

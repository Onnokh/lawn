import sharp from 'sharp';

/**
 * Cut the minimap frame out of the quest card.
 *
 * The card is one piece of painted artwork with a dark green inset in the
 * middle. The minimap needs two things from it: the frame with the inset made
 * transparent, so the Lawn can be drawn through it, and a mask of exactly that
 * opening, so what is drawn is clipped to it. Both come from the one painting,
 * which is what keeps the hole and the mask the same shape.
 *
 * It answers with raw pixels rather than files: `build-assets.mjs` decides what
 * they are written as.
 */
export async function minimapFrame(source = 'art/quest-card.png') {
const { data, info } = await sharp(source)
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;
const selected = new Uint8Array(width * height);
const queue = new Uint32Array(width * height);
const seed = Math.floor(height / 2) * width + Math.floor(width / 2);
let head = 0, tail = 1;
queue[0] = seed;
selected[seed] = 1;
function visit(i) {
  if (selected[i]) return;
  const p = i * 4;
  const [r, g, b, a] = data.subarray(p, p + 4);
  // Only remove the connected dark-green inset, preserving isolated leaves.
  if (a > 100 && r < 130 && g < 160 && g > r * 1.1 && g > b * 1.05) {
    selected[i] = 1;
    queue[tail++] = i;
  }
}
while (head < tail) {
  const i = queue[head++], x = i % width, y = Math.floor(i / width);
  if (x > 0) visit(i - 1);
  if (x < width - 1) visit(i + 1);
  if (y > 0) visit(i - width);
  if (y < height - 1) visit(i + width);
}
if (tail < width * height * 0.5 || tail > width * height * 0.85) {
  throw new Error(`Unexpected opening size: ${tail} pixels`);
}
const mask = Buffer.alloc(data.length);
for (let i = 0; i < selected.length; i++) {
  if (!selected[i]) continue;
  data[i * 4 + 3] = 0;
  mask.fill(255, i * 4, i * 4 + 4);
}
return { frame: data, opening: mask, info, removed: tail };
}

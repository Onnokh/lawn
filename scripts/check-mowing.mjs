import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { MOWER_SCALE, DECK_SIZE, DECK_OFFSET, MOW_RADIUS, COLLISION_RADIUS, forEachMownTile } from '../public/mowing.js';
import { cutSwath } from '../.checks/ground/cutting.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const W = 408, H = 272;
const client = vm.createContext({ Date, Math, performance, W, H, RADIUS:MOW_RADIUS, forEachMownTile,
  mownAt:new Float64Array(W*H), mowDir:new Float32Array(W*H), clockOffset:0, settling:new Map(),
  heightAt:()=>1, paintDir(){}, fieldDirty:false, onGrass:()=>true, bladesCut:0,
  mowerSound:{cut(){}}, throwClippings(){} });
vm.runInContext(html.slice(html.indexOf('function cut('),html.indexOf('/* ---- the shared lawn')), client);
// The Lawn cuts the real swath, on ground that is all grass and all alike:
// what a swath touches is geometry, and this is a check of the geometry.
const ground = { mownAt:new Uint32Array(W*H), fieldOf:new Uint8Array(W*H),
  regrow:new Float32Array(W*H).fill(7200), byField:new Float64Array(9), bare:255 };
const changed = array => Array.from(array.keys()).filter(i=>array[i]>0);

// Extract the housing vertices from the real model, not a duplicate drawing.
const meshScope = vm.createContext({Math,Float32Array,MOWER_SCALE,DECK_SIZE,DECK_OFFSET,
  norm:v=>v,sub:(a,b)=>a.map((v,i)=>v-b[i]),cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]});
vm.runInContext(html.slice(html.indexOf('function mowerMesh()'),html.indexOf('/* ---- GPU setup ---- */'))+';globalThis.mesh=mowerMesh()',meshScope);
const ring = new Map();
for(let i=0;i<meshScope.mesh.length;i+=7) {
  const [x,y,z,,,,material] = meshScope.mesh.slice(i,i+7);
  if(material===0 && Math.abs(y-0.24)<0.00001) ring.set(`${x},${z}`,[x*MOWER_SCALE,z*MOWER_SCALE]);
}
// Triangle fans include the centre, which is not on the hull.
const hull = [...ring.values()].filter(([x,y])=>Math.hypot(x-DECK_OFFSET*MOWER_SCALE,y)>1)
  .sort((a,b)=>Math.atan2(a[1],a[0]-DECK_OFFSET*MOWER_SCALE)-Math.atan2(b[1],b[0]-DECK_OFFSET*MOWER_SCALE));
assert.equal(hull.length,24);
function insideDeck(x,y) {
  return hull.every(([ax,ay],i)=> {
    const [bx,by]=hull[(i+1)%hull.length];
    return (bx-ax)*(y-ay)-(by-ay)*(x-ax)>=-1e-6;
  });
}
for(let angle=0;angle<Math.PI*2;angle+=0.01) {
  assert.ok(insideDeck(Math.cos(angle)*MOW_RADIUS,Math.sin(angle)*MOW_RADIUS),'blade circle fits inside actual rendered housing');
}
assert.equal(COLLISION_RADIUS,2.6*0.85,'cut size does not change mower collision size');

// Cuts at the front and sides, reverse travel, sideways drift and road-speed steps.
const strokes = [[100,100,100.1,100],[100,100,102.5,100],[100,100,97.5,100],
  [100,100,100,102.5],[100.37,100.82,102.13,102.58],[0,0,2,1],[407,271,408,272]];
for(const stroke of strokes) {
  client.mownAt.fill(0); client.bladesCut=0; client.settling.clear();
  ground.mownAt.fill(0);
  client.cut(...stroke,0,true);
  // A Tile nobody ever mowed is fully overgrown, so every Tile the swath
  // touches gives up exactly one blade and the sum is the tile count.
  const score=cutSwath(ground,...stroke,Math.floor(Date.now()/1000));
  const local=changed(client.mownAt);
  assert.deepEqual(local,changed(ground.mownAt),'optimistic cut and server cut touch identical tiles');
  assert.equal(score,local.length);
  assert.equal(client.bladesCut,score);
  assert.equal(ground.byField[0],score);
  const [x0,y0,x1,y1]=stroke,dx=x1-x0,dy=y1-y0,len2=dx*dx+dy*dy;
  for(const i of local) {
    const x=i%W+0.5,y=Math.floor(i/W)+0.5;
    const t=Math.max(0,Math.min(1,((x-x0)*dx+(y-y0)*dy)/len2));
    const ox=x-x0-t*dx,oy=y-y0-t*dy;
    // A circular blade stays inside the deck whatever the heading during a slide.
    for(let heading=0;heading<Math.PI*2;heading+=Math.PI/12) {
      const ca=Math.cos(heading),sa=Math.sin(heading);
      assert.ok(insideDeck(ox*ca+oy*sa,-ox*sa+oy*ca),'cut tile centre stays under the swept housing');
    }
  }
}
const whole=new Set(),split=new Set();
forEachMownTile(100,100,125,103,W,H,MOW_RADIUS,i=>whole.add(i));
for(let i=0;i<60;i++) forEachMownTile(100+25*i/60,100+3*i/60,100+25*(i+1)/60,100+3*(i+1)/60,W,H,MOW_RADIUS,j=>split.add(j));
assert.deepEqual([...whole].sort((a,b)=>a-b),[...split].sort((a,b)=>a-b),'frame rate and reporting cadence do not change a straight swath');
// Shader sampling must use actual blade roots, not random points outside the cut.
assert.match(html,/let h = hSmooth\(root\);/);
assert.match(html,/let h = hSmooth\(w\);/);
assert.ok(!html.includes('hSmooth(root + wobble)'));
for(const match of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) await transform(match[1],{loader:'js',format:'esm'});
console.log('Mowing: blade fits the rendered deck in every heading; client/server tiles and scores agree; reverse, drift, boost, edges and split strokes pass.');

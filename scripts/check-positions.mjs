import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
import { motion, addReport, samplePeer, PositionReports, INTERP_DELAY, PREDICT_MS } from '../public/positions.js';
import { slipstream } from '../public/driving.js';

const report = (t, x, vx = 25, y = 100, vy = 0, a = 0) => ({ t, x, y, vx, vy, a });
const buf = [report(0, 100), report(100, 102.5)];
assert.equal(samplePeer(buf, 150).x, 103.75, 'boosted mower keeps moving between reports');
assert.equal(samplePeer(buf, 150).vx, 25, 'draft and collision velocity survives a report gap');
assert.equal(samplePeer(buf, 1000).x, 102.5 + 25 * PREDICT_MS / 1000);
assert.equal(samplePeer(buf, 1000).vx, 0, 'long outage stops prediction');
assert.equal(samplePeer([report(0, 10, 0)], 120).x, 10, 'parked mower stays parked');
assert.equal(samplePeer([report(0, 10, 0, 10, 20)], 100).y, 12, 'drift uses travel, not heading');
assert.ok(Math.abs(samplePeer([report(0, 0, 0, 0, 0, 3.1), report(100, 0, 0, 0, 0, -3.1)], 50).a - Math.PI) < 0.01);
assert.deepEqual(motion(NaN, 3), undefined);
assert.deepEqual(motion('25', 0), undefined);
assert.equal(Math.hypot(...Object.values(motion(300, 400))), 25);
const history = [];
for (let i = 0; i < 1000; i++) addReport(history, report(i, i));
assert.equal(history.length, 32, 'background tabs have bounded history');
addReport(history, report(999, 1001));
addReport(history, report(998, -999));
assert.equal(history.at(-1).x, 1001, 'duplicate timestamps replace; stale reports are ignored');

const pending = new PositionReports();
const first = pending.sent(100, 100), second = pending.sent(102, 100);
assert.deepEqual(pending.accept(first, 98, 100), { x: -2, y: 0 });
assert.deepEqual(pending.accept(second, 100, 100), { x: 0, y: 0 }, 'in-flight reports do not double-correct');
assert.equal(pending.accept(first, 98, 100), undefined);
const third = pending.sent(101, 100);
assert.deepEqual(pending.accept(third, 101, 100), { x: 0, y: 0 }, 'subsequent accepted travel stays intact');

// Exercise the actual frame sampler, including smoothing and obstacle handling.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sampler = html.slice(html.indexOf('function blendAngle('), html.indexOf('/**\n * The Mowers the field draws'));
const scope = vm.createContext({ Math, samplePeer, W: 1000, H: 272, COLLISION_RADIUS: 2.21,
  stepAshore: (x, y, dx, dy) => [x + dx, y + dy] });
vm.runInContext(sampler + ';globalThis.sample=interpolatePeer', scope);
for (const speed of [8.4, 20, 25]) {
  for (const hz of [30, 60, 120]) {
    const p = { x: 100, y: 100, a: 0, buf: [] };
    const queue = [];
    for (let t = 0, i = 0; t <= 4000; t += 100, i++) {
      queue.push({ arrival: t + [20, 45, 25, 70, 30][i % 5], value: report(t, 100 + speed * t / 1000, speed) });
    }
    let maxError = 0;
    for (let t = 0; t < 4000; t += 1000 / hz) {
      while (queue.length && queue[0].arrival <= t) addReport(p.buf, queue.shift().value);
      scope.sample(p, t - INTERP_DELAY, 1 / hz);
      if (t > 500) {
        maxError = Math.max(maxError, Math.abs(p.x - (100 + speed * t / 1000)));
        assert.ok(p.vx > 0, 'jitter must not flicker travel velocity off');
        assert.ok(slipstream({x:p.x-12,y:100,a:0,v:speed}, [{...p,seen:t}], t, () => 1) > 0.9);
      }
    }
    assert.ok(maxError < 1.6, `${speed} tiles/s at ${hz}Hz: error ${maxError}`);
  }
}
// Upstream and downstream jitter affect server timestamps and receipt separately.
const observers = [20, 55].map(delay => ({delay, p:{x:100,y:100,a:0,buf:[]}, queue:[]}));
for (let t=0,i=0;t<4000;t+=100,i++) {
  const stamped=t+[20,45,25,70,30][i%5];
  for (const observer of observers) observer.queue.push({arrival:stamped+observer.delay,
    value:report(stamped,100+25*t/1000)});
}
for (let t=0;t<4000;t+=1000/60) {
  for (const observer of observers) {
    while (observer.queue.length && observer.queue[0].arrival<=t) addReport(observer.p.buf,observer.queue.shift().value);
    scope.sample(observer.p,t-INTERP_DELAY,1/60);
    if (t>500) assert.ok(Math.abs(observer.p.x-(100+25*t/1000))<3.5,'bounded lag with jitter in both directions');
  }
  if (t>500) assert.ok(Math.abs(observers[0].p.x-observers[1].p.x)<1.5,'different receivers agree within bounded prediction error');
}
const wallScope = vm.createContext({ Math, samplePeer, W: 408, H: 272, COLLISION_RADIUS: 2.21,
  stepAshore: (x,y,dx,dy) => x+dx > 105 ? [x,y] : [x+dx,y+dy] });
vm.runInContext(sampler + ';globalThis.sample=interpolatePeer', wallScope);
const atWall = {x:104,y:100,a:0,buf:[report(0,104)]};
for (let t = 0; t < 500; t += 16) wallScope.sample(atWall,t,0.016);
assert.ok(atWall.x <= 105, 'prediction never drives through a bank');

// Exercise the actual send cadence: a stop at an unchanged position is news.
let frameNow = 1000;
const packets = [], order = [];
const driving = vm.createContext({Math, Date, performance:{now:()=>frameNow},
  INTERP_DELAY, PEER_TIMEOUT:4000, SEND_MS:100, STILL_SEND_MS:500,
  mowing:0, clockOffset:0, peers:new Map([['peer',{seen:1000,x:120,y:100,a:0}]]), lastContact:new Map(),
  interpolatePeer(){order.push('peers');}, stunUntil:0, held:()=>false, pickerOpen:false,
  stick:{mag:0}, me:{x:100,y:100,a:0,v:25,draft:0}, W:408,H:272,
  roadAt:()=>1, bite:()=>0, slipstream:()=>0, touchBrake:false,
  stepDrive:()=>({vx:25,vy:0,drifting:false}), reducedMotion:{matches:false},
  leanBody(){},angleGap:()=>0,moveMower(dx,dy){order.push('drive');this.me.x+=dx;this.me.y+=dy;},
  ease:(_from,to)=>to,DRIFT_TAU:0.1,
  cut(){},positionSavedAt:1000,savePosition(){}, connected:true,sendAt:0,
  sentX:null,sentY:null,sentA:null,sentMoving:false,reportMotion:motion,
  positionReports:new PositionReports(),send:m=>packets.push(m),mowerCount:0,showMowerCount(){}
});
// Functions called from the VM do not receive its globals as `this`.
driving.moveMower=(dx,dy)=>{order.push('drive');driving.me.x+=dx;driving.me.y+=dy;};
const driveSource=html.slice(html.indexOf('function drive(dt, lawnNow)'),html.indexOf('/** Blend headings'));
vm.runInContext(driveSource+';drive(1/60,1000)',driving);
assert.deepEqual(order.slice(0,2),['peers','drive'],'sample peers before collision and drafting');
assert.equal(packets[0].vx,25);
assert.ok(JSON.stringify(packets[0]).length<=256,'motion report fits server message limit');
driving.moveMower=()=>{};
frameNow+=110;
vm.runInContext('drive(1/60,1110)',driving);
assert.equal(packets.length,2,'stop report does not wait for the idle heartbeat');
assert.equal(packets[1].vx,0);
frameNow+=110;
vm.runInContext('drive(1/60,1220)',driving);
assert.equal(packets.length,2,'idle frames keep the existing traffic budget');

// Run the real server message handler and speed limiter with in-memory sockets.
const bundled = await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'node',
  plugins:[{name:'workers-test', setup(b) {
    b.onResolve({filter:/^cloudflare:workers$/}, () => ({path:'workers',namespace:'test'}));
    b.onLoad({filter:/.*/,namespace:'test'}, () => ({contents:'export class DurableObject {}'}));
  }}]});
const { Lawn } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
function lawn() {
  const game = Object.create(Lawn.prototype);
  Object.assign(game, {places:new WeakMap(),travelBudgets:new Map(),budgets:new WeakMap(),scores:new Map(),strokes:0,
    trackBallMower(){},tell(){},schedulePersist(){},watchFields(){},mow(){return 0;},resync(){},
    messages:[],broadcast(raw){this.messages.push(JSON.parse(raw));}});
  return game;
}
let now = 10000;
const dateNow = Date.now;
Date.now = () => now;
try {
  const game = lawn(), accepted = [];
  const socket = {deserializeAttachment:()=>({id:'driver'}),send:raw=>accepted.push(JSON.parse(raw))};
  // Isolate the travel budget from terrain; map and bank behavior have separate checks.
  game.dryRun = (_from,_ux,_uy,distance) => distance;
  const send = (seq,x,vx=25) => game.webSocketMessage(socket,JSON.stringify({t:'mow',x,y:100,a:0,vx,vy:0,seq}));
  send(1,100);
  assert.equal(game.messages.at(-1).t,'peer','first report establishes presence immediately');
  for (let i=1;i<=20;i++) {
    now += 100;
    send(i+1,100+i*2.5);
    assert.equal(accepted.at(-1).x,100+i*2.5,'server accepts sustained maximum boost speed');
    assert.equal(game.messages.at(-1).vx,25);
  }
  now += 100;
  send(22,200);
  const correction = accepted.at(-1), peer = game.messages.at(-1);
  assert.ok(correction.x < 200,'speed violation is limited');
  assert.equal(correction.x,peer.x,'driver and observers receive identical accepted position');
  assert.equal(peer.vx,0,'rejected travel is not extrapolated');
  now += 100;
  send(23,correction.x,0);
  assert.equal(game.messages.at(-1).vx,0,'stop is explicitly broadcast');
  now += 100;
  game.webSocketMessage(socket,JSON.stringify({t:'mow',x:correction.x,y:100,a:0}));
  assert.equal(game.messages.at(-1).t,'peer','old clients can still report');
} finally { Date.now = dateNow; }
console.log('Position prediction, jitter at 30/60/120Hz, drafting, stops, drift, stale peers, bounds, acknowledgements and server boost limits pass.');

// Two independent source processes. Check included, excluded, and source ducking.
const { spawn, execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const root = join(__dirname, '..'), helper = join(root,'native/bin/YingBan.Audio.exe'), tonePath = join(root,'native/bin/TestTone.exe');
execFileSync(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo','/platform:x64','/out:'+tonePath,join(__dirname,'NativeTone.cs')]);
const children = [];
function start(path, args) {
  const child = spawn(path,args,{windowsHide:true,stdio:['pipe','pipe','pipe']}); children.push(child); child.packets=[];
  child.stdout.on('data',b=>child.packets.push({time:Date.now(),b}));
  child.ready = new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Helper timeout')),12000); let message='';
    child.stderr.on('data',b=>{message+=b;if(message.includes('READY')){clearTimeout(timeout);resolve();}});
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);if(code)reject(new Error(message));});
  });return child;
}
function spectrum(child,start,end,frequency){
  const b=Buffer.concat(child.packets.filter(x=>x.time>=start&&x.time<end).map(x=>x.b));
  let cos=0,sin=0,frames=Math.floor(b.length/4);
  for(let i=0;i<frames;i++){const x=b.readInt16LE(i*4)/32768,theta=2*Math.PI*frequency*i/48000;cos+=x*Math.cos(theta);sin+=x*Math.sin(theta);}
  return 2*Math.hypot(cos,sin)/Math.max(frames,1);
}
(async()=>{
 try{
  const a=start(tonePath,['15','697']),b=start(tonePath,['15','1209']);await Promise.all([a.ready,b.ready]);
  const all=start(helper,['4','0']),onlyA=start(helper,['4','0',String(a.pid)]),excludeA=start(helper,[String(a.pid),'0']);
  await Promise.all([all.ready,onlyA.ready,excludeA.ready]);a.stdin.write('PLAY\n');b.stdin.write('PLAY\n');await delay(600);
  let from=Date.now();await delay(900);let to=Date.now();
  const before={allA:spectrum(all,from,to,697),allB:spectrum(all,from,to,1209),onlyA:spectrum(onlyA,from,to,697),leakedB:spectrum(onlyA,from,to,1209),excludedA:spectrum(excludeA,from,to,697),excludedB:spectrum(excludeA,from,to,1209)};
  assert(before.allA>0.002 && before.allB>0.002,'Whole screen scope must capture both apps');
  assert(before.onlyA>0.002 && before.leakedB<before.allB*0.03,'App scope must isolate A');
  assert(before.excludedA<before.allA*0.03 && before.excludedB>0.002,'Exclusion must remove only the call tree');
  onlyA.stdin.write('DUCK 0.2\n');await delay(500);from=Date.now();await delay(900);to=Date.now();
  const duck={a:spectrum(all,from,to,697),b:spectrum(all,from,to,1209)};
  assert(duck.a<before.allA*0.4,'Selected app must duck');assert(duck.b>before.allB*0.8,'Unrelated app must retain volume');
  onlyA.stdin.end('\n');await delay(500);from=Date.now();await delay(900);to=Date.now();
  const restored={a:spectrum(all,from,to,697),b:spectrum(all,from,to,1209)};
  assert(restored.a>before.allA*0.8,'Closing capture must restore A');
  fs.mkdirSync(join(root,'test-results'),{recursive:true});fs.writeFileSync(join(root,'test-results/scope-result.json'),JSON.stringify({passed:true,before,duck,restored},null,2));
  console.log(JSON.stringify({passed:true,before,duck,restored},null,2));
 }finally{for(const c of children)if(c.exitCode===null&&c.stdin.writable)c.stdin.end('\n');await delay(400);for(const c of children)if(c.exitCode===null)c.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});

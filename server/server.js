// Форма.дома — маленький сервер для старого телефона (Termux).
// Синхронизация, уведомления по распорядку и ежедневные копии данных.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
let webpush=null;try{webpush=require('web-push')}catch(e){console.log('! web-push не установлен — уведомления выключены (npm install)')}
const DIR=path.join(__dirname,'data'),BK=path.join(DIR,'backups');fs.mkdirSync(BK,{recursive:true});
const F={cfg:path.join(DIR,'config.json'),st:path.join(DIR,'state.json'),sub:path.join(DIR,'subs.json'),sent:path.join(DIR,'sent.json')};
const rd=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){return d}};
const wr=(f,v)=>{fs.writeFileSync(f+'.tmp',JSON.stringify(v));fs.renameSync(f+'.tmp',f)};
const ORIGINS=['https://bloods-repo.github.io'];

let cfg=rd(F.cfg,null);
if(!cfg){cfg={key:crypto.randomBytes(18).toString('base64url'),port:8787};wr(F.cfg,cfg)}
if(webpush&&!cfg.vapid){cfg.vapid=webpush.generateVAPIDKeys();wr(F.cfg,cfg)}
if(process.argv.includes('--key')){console.log(cfg.key);process.exit(0)}
if(webpush)webpush.setVapidDetails('mailto:forma@localhost.invalid',cfg.vapid.publicKey,cfg.vapid.privateKey);

let state=rd(F.st,null),subs=rd(F.sub,[]),sent=rd(F.sent,{});

// Слияние: по каждому дню побеждает более свежая правка, остальное — от более новой копии.
function merge(a,b){
  if(!a||!a.log)return b;if(!b||!b.log)return a;
  const nw=(a.upd||0)>=(b.upd||0)?a:b,old=nw===a?b:a,out=Object.assign({},old,nw);
  out.log={};for(const k of new Set([...Object.keys(a.log),...Object.keys(b.log)])){const x=a.log[k],y=b.log[k];out.log[k]=!x?y:!y?x:((x.u||0)>=(y.u||0)?x:y)}
  out.rec={};for(const id of new Set([...Object.keys(a.rec||{}),...Object.keys(b.rec||{})])){const m=new Map();for(const r of[...((a.rec||{})[id]||[]),...((b.rec||{})[id]||[])])m.set(r.d+'|'+r.v,r);out.rec[id]=[...m.values()].sort((p,q)=>p.d<q.d?-1:p.d>q.d?1:0)}
  out.badges=Object.assign({},old.badges,nw.badges);out.upd=Math.max(a.upd||0,b.upd||0);
  return out}

function backup(){const d=new Date(),k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  wr(path.join(BK,k+'.json'),state);
  const fl=fs.readdirSync(BK).filter(f=>f.endsWith('.json')).sort();while(fl.length>60)fs.unlinkSync(path.join(BK,fl.shift()))}

const sha=s=>crypto.createHash('sha256').update(String(s)).digest();
function reply(res,code,obj,origin){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':origin,'Vary':'Origin',
  'Access-Control-Allow-Headers':'Authorization, Content-Type, ngrok-skip-browser-warning','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Max-Age':'86400'});
  res.end(obj==null?'':JSON.stringify(obj))}
function body(req){return new Promise((ok,no)=>{let n=0,c=[];req.on('data',d=>{n+=d.length;if(n>8e6){no(Error('too big'));req.destroy()}else c.push(d)});req.on('end',()=>{try{ok(c.length?JSON.parse(Buffer.concat(c)):{})}catch(e){no(e)}})})}

async function push(p){if(!webpush)return 0;const dead=[];let n=0;
  for(const s of subs){try{await webpush.sendNotification(s,JSON.stringify(p),{TTL:3600});n++}catch(e){if(e.statusCode===404||e.statusCode===410)dead.push(s.endpoint);else console.log('push error',e.statusCode||e.message)}}
  if(dead.length){subs=subs.filter(s=>!dead.includes(s.endpoint));wr(F.sub,subs)}return n}

http.createServer(async(req,res)=>{
  const o=req.headers.origin||'',allow=ORIGINS.includes(o)||/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)?o:ORIGINS[0];
  try{
    if(req.method==='OPTIONS')return reply(res,204,null,allow);
    const p=new URL(req.url,'http://x').pathname;
    if(p==='/'||p==='/api/ping')return reply(res,200,{ok:true,app:'forma',push:!!webpush},allow);
    const k=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!crypto.timingSafeEqual(sha(k),sha(cfg.key)))return reply(res,401,{error:'Неверный ключ'},allow);
    if(p==='/api/vapid')return reply(res,200,{key:webpush?cfg.vapid.publicKey:null},allow);
    if(p==='/api/sync'&&req.method==='POST'){const b=await body(req);if(!b.state||!b.state.log)return reply(res,400,{error:'Нет данных'},allow);
      state=merge(state,b.state);wr(F.st,state);backup();return reply(res,200,{state},allow)}
    if(p==='/api/subscribe'&&req.method==='POST'){const b=await body(req);if(!b.sub||!b.sub.endpoint)return reply(res,400,{error:'Нет подписки'},allow);
      subs=subs.filter(s=>s.endpoint!==b.sub.endpoint);subs.push(b.sub);wr(F.sub,subs);return reply(res,200,{ok:true,devices:subs.length},allow)}
    if(p==='/api/test'&&req.method==='POST'){const n=await push({title:'Форма.дома',body:'Тестовое уведомление: сервер работает',tag:'test'});return reply(res,200,{sent:n},allow)}
    reply(res,404,{error:'Нет такого адреса'},allow);
  }catch(e){console.log('error',e.message);reply(res,500,{error:'Ошибка сервера'},allow)}
}).listen(cfg.port,'127.0.0.1',()=>{
  console.log('Форма.дома: сервер запущен на порту '+cfg.port);
  console.log('Ключ для приложения: '+cfg.key);
  console.log('Уведомления: '+(webpush?'включены':'выключены'));
});

// Напоминания: приложение присылает список, сервер отправляет вовремя, если пункт ещё не отмечен.
function done(c){const l=((state&&state.log)||{})[c.d];if(!l)return false;
  if(c.k==='m')return!!(l.m||{})[c.id];if(c.k==='x')return!!(l.sc||{})[c.id];if(c.k==='w')return(l.w||0)>=(c.n||1);if(c.k==='wo')return(c.ids||[]).length>0&&c.ids.every(i=>(l.x||{})[i]);return false}
setInterval(async()=>{if(!webpush||!state||!Array.isArray(state.rem)||!subs.length)return;const now=Date.now();let ch=false;
  for(const r of state.rem){if(!r||!r.id||r.at>now||r.at<now-20*60e3||sent[r.id])continue;sent[r.id]=now;ch=true;
    if(r.chk&&done(r.chk))continue;await push({title:r.title,body:r.body||'',tag:r.id})}
  for(const k in sent)if(sent[k]<now-4*864e5){delete sent[k];ch=true}
  if(ch)wr(F.sent,sent)},30000);

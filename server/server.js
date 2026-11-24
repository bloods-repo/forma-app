// Форма.дома — маленький сервер для старого телефона (Termux).
// Синхронизация, уведомления по распорядку, копии данных, недельный отчёт,
// автопрогрессия тренировок и погода.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
let webpush=null;try{webpush=require('web-push')}catch(e){console.log('! web-push не установлен — уведомления выключены (npm install)')}
const DIR=path.join(__dirname,'data'),BK=path.join(DIR,'backups');fs.mkdirSync(BK,{recursive:true});
const MO=path.join(BK,'months');fs.mkdirSync(MO,{recursive:true});
const F={cfg:path.join(DIR,'config.json'),st:path.join(DIR,'state.json'),sub:path.join(DIR,'subs.json'),sent:path.join(DIR,'sent.json'),wx:path.join(DIR,'weather.json')};
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
  out.badges=Object.assign({},old.badges,nw.badges);
  const au=x=>(x&&x.auto&&x.auto.u)||0;out.auto=au(a)>=au(b)?a.auto:b.auto;if(!out.auto)delete out.auto;out.upd=Math.max(a.upd||0,b.upd||0);
  return out}

function backup(){const d=new Date(),k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  wr(path.join(BK,k+'.json'),state);wr(path.join(MO,k.slice(0,7)+'.json'),state); // помесячные копии не удаляются никогда
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
      const oldCity=state&&state.city;state=merge(state,b.state);wr(F.st,state);backup();
      if((state.city||'')!==(oldCity||'')||!wx||wx.city!==(state.city||''))weather().catch(()=>{});
      return reply(res,200,{state,wx,info:info()},allow)}
    if(p==='/api/wx'){if(!wx||Date.now()-wx.at>36e5)await weather().catch(()=>{});return reply(res,200,{wx},allow)}
    if(p==='/api/report'&&req.method==='POST'){const w=report();if(!w)return reply(res,200,{sent:0},allow);const n=await push({title:w.title,body:w.body,tag:'week'});return reply(res,200,{sent:n,report:w},allow)}
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

// ---------- общие расчёты (как в приложении) ----------
const dk=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const pk=k=>{const[a,b,c]=k.split('-').map(Number);return new Date(a,b-1,c)};
const addD=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x};
const DAYMS=864e5,STAGES=['Знакомство','Привыкание','Укрепление','Уверенный старт'];
const weekOf=k=>Math.max(0,Math.floor((pk(k)-pk(state.plan.start))/DAYMS/7));
const stageOf=k=>Math.min(3,Math.floor(weekOf(k)/2));
const LG=k=>(state.log||{})[k]||{x:{},m:{},h:{},w:0,kg:''};
function score(k){const l=LG(k),pl=state.plan,ex=pl.days[pk(k).getDay()]||[];let tot=ex.length+pl.meals.length+pl.habits.length+1,d=0;
  ex.forEach(e=>(l.x||{})[e.id]&&d++);pl.meals.forEach(e=>(l.m||{})[e.id]&&d++);pl.habits.forEach(e=>(l.h||{})[e.id]&&d++);if((l.w||0)>=pl.water)d++;return tot?d/tot:0}
function info(){const ks=Object.keys((state&&state.log)||{}).filter(k=>{const l=state.log[k];return l&&(Object.keys(l.x||{}).length||Object.keys(l.m||{}).length||Object.keys(l.h||{}).length||l.w||l.kg)}).sort();
  return{days:ks.length,first:ks[0]||null,months:fs.readdirSync(MO).filter(f=>f.endsWith('.json')).length}}
const fmt=v=>String(Math.round(v*10)/10).replace('.',',');

// ---------- недельный отчёт: воскресенье 20:00 ----------
function report(){if(!state||!state.plan||!state.log)return null;const t=new Date(),days=[];for(let i=6;i>=0;i--)days.push(dk(addD(t,-i)));
  let wp=0,wd=0,sum=0,water=0;for(const k of days){const ex=state.plan.days[pk(k).getDay()]||[],l=LG(k);
    if(ex.length>2){wp++;if(ex.filter(e=>(l.x||{})[e.id]).length>=Math.ceil(ex.length*.7))wd++}
    sum+=score(k);if((l.w||0)>=state.plan.water)water++}
  const avg=Math.round(sum/7*100);
  const kgs=Object.keys(state.log).filter(k=>parseFloat(state.log[k].kg)>0).sort(),before=kgs.filter(k=>k<days[0]).pop(),inw=kgs.filter(k=>k>=days[0]).pop();
  let kg='';if(inw&&before){const d=parseFloat(state.log[inw].kg)-parseFloat(state.log[before].kg);kg=' · вес '+(d>0?'+':d<0?'−':'±')+fmt(Math.abs(d))+' кг'}
  else if(inw)kg=' · вес '+fmt(parseFloat(state.log[inw].kg))+' кг';
  let st=0;for(let i=0;i<400;i++){const s=score(dk(addD(t,-i)));if(s>=.7)st++;else if(i>0)break}
  const rec=Object.values(state.rec||{}).reduce((a,l)=>a+l.filter(r=>r.d>=days[0]).length,0);
  return{title:`Итоги недели: ${avg}% выполнено`,body:`Тренировок ${wd} из ${wp}${kg} · вода ${water}/7 дн.${st>1?' · серия '+st+' дн.':''}${rec?' · рекордов: '+rec:''}`}}

// ---------- автопрогрессия: по итогам недели сдвигает этап ----------
function progress(){if(!state||!state.plan||!state.log)return null;const t=new Date(),days=[];for(let i=6;i>=0;i--)days.push(dk(addD(t,-i)));
  if(state.plan.advAt&&state.plan.advAt>=days[0])return null; // на этой неделе уже меняли вручную
  let pl=0,dn=0;const rt=[];for(const k of days){const ex=(state.plan.days[pk(k).getDay()]||[]).filter(e=>e.s),l=LG(k);pl+=ex.length;dn+=ex.filter(e=>(l.x||{})[e.id]).length;if(l.r)rt.push(l.r)}
  if(!pl)return null;const c=dn/pl,k=dk(t),w=weekOf(k),s=stageOf(k),easy=rt.filter(v=>v===1).length,hard=rt.filter(v=>v===3).length,pc=Math.round(c*100);
  if((c<.5||hard>=2)&&w>0)return{delta:7,kind:'slow',title:'Эта неделя — повтор',body:c<.5?`Сделано ${pc}% упражнений — повторяем неделю с той же нагрузкой.`:'Тренировки шли тяжело — повторяем неделю, станет легче.'};
  if(c>=.8&&easy>=2&&s<3){const need=(s+1)*2-w;return{delta:-need*7,kind:'fast',title:'Новый этап: «'+STAGES[s+1]+'»',body:`Сделано ${pc}%, и было легко — нагрузка растёт.`}}
  const ns=stageOf(dk(addD(t,1)));if(ns>s)return{delta:0,kind:'up',title:'Новый этап: «'+STAGES[ns]+'»',body:`Сделано ${pc}% — по плану поднимаем нагрузку.`};
  return{delta:0,kind:'keep',title:'Нагрузка без изменений',body:`Сделано ${pc}% упражнений, этап «${STAGES[s]}». Так держать.`}}

setInterval(async()=>{if(!state)return;const t=new Date();if(t.getDay()!==0||t.getHours()<20)return;const k='week|'+dk(t);if(sent[k])return;
  sent[k]=Date.now();wr(F.sent,sent); // помечаем неделю, чтобы не слать дважды
  const w=report();if(w)await push({title:w.title,body:w.body,tag:'week'});
  const g=progress();if(g){if(g.delta){state.auto={u:Date.now(),delta:g.delta,kind:g.kind,week:dk(t),msg:g.title+'. '+g.body};wr(F.st,state)}
    setTimeout(()=>push({title:g.title,body:g.body,tag:'prog'}),4000)}},60000);

// ---------- погода: раз в час для города из профиля ----------
let wx=rd(F.wx,null);
const WXD={0:'ясно',1:'почти ясно',2:'облачно',3:'пасмурно',45:'туман',48:'туман',51:'морось',53:'морось',55:'морось',56:'ледяная морось',57:'ледяная морось',61:'дождь',63:'дождь',65:'ливень',66:'ледяной дождь',67:'ледяной дождь',71:'снег',73:'снег',75:'снегопад',77:'снежная крупа',80:'ливень',81:'ливень',82:'ливень',85:'снег',86:'снегопад',95:'гроза',96:'гроза с градом',99:'гроза с градом'};
async function weather(){const city=(state&&state.city||'').trim();if(!city){wx=null;try{fs.unlinkSync(F.wx)}catch(e){}return}
  let geo=wx&&wx.city===city&&wx.lat!=null?{latitude:wx.lat,longitude:wx.lon,name:wx.name}:null;
  if(!geo){const g=await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=ru&name='+encodeURIComponent(city))).json();geo=g&&g.results&&g.results[0];if(!geo)throw Error('город не найден')}
  const u=`https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,weather_code,is_day,precipitation&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&forecast_days=1`;
  const j=await (await fetch(u)).json(),c=j.current;
  wx={city,name:geo.name,lat:geo.latitude,lon:geo.longitude,at:Date.now(),t:Math.round(c.temperature_2m),code:c.weather_code,desc:WXD[c.weather_code]||'',day:!!c.is_day,pr:c.precipitation,
    tmax:Math.round(j.daily.temperature_2m_max[0]),tmin:Math.round(j.daily.temperature_2m_min[0]),sunrise:j.daily.sunrise[0],sunset:j.daily.sunset[0]};wr(F.wx,wx)}
setInterval(()=>weather().catch(e=>console.log('погода:',e.message)),36e5);setTimeout(()=>weather().catch(()=>{}),3000);

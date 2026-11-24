const C='forma-v23';
const FILES=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','badge-96.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES.map(u=>new Request(u,{cache:'reload'})))));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);if(r.method!=='GET'||u.pathname.includes('/api/')||u.pathname.endsWith('version.txt'))return;
  if(r.mode==='navigate'||u.pathname.endsWith('/index.html')){
    // открываемся сразу из памяти, свежую версию проверяем в фоне
    e.respondWith(caches.open(C).then(async c=>{const hit=await c.match('index.html');
      const net=fetch(new Request('index.html',{cache:'no-cache'})).then(async res=>{if(res&&res.ok){await c.put('index.html',res.clone())}return res});
      if(hit){e.waitUntil(net.catch(()=>{}));return hit}
      return net.catch(()=>c.match('./'))}));return}
  e.respondWith(caches.match(r).then(hit=>{const net=fetch(r).then(res=>{if(res&&(res.ok||res.type==='opaque')){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp))}return res}).catch(()=>hit);return hit||net}))});
self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch(_){d={body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'Форма.дома',{body:d.body||'',icon:'icon-192.png',badge:'badge-96.png',tag:d.tag||undefined,lang:'ru'}))});
self.addEventListener('notificationclick',e=>{e.notification.close();
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{for(const w of ws)if('focus' in w)return w.focus();return clients.openWindow('./')}))});

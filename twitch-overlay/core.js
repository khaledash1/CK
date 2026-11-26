/* مكتبة مشتركة: تطبيق الإعدادات + الاتصال بـ StreamElements + أدوات */
(function(){
  const C = window.STREAM_CONFIG || {};
  const root = document.documentElement.style;
  for (const [k,v] of Object.entries(C.colors||{})) root.setProperty('--'+k, v);

  const ICONS = {
    twitch:'<svg viewBox="0 0 24 24"><path d="M4 2 2 6v14h5v3h3l3-3h4l5-5V2H4zm16 12-3 3h-5l-3 3v-3H5V4h15v10zM15 7h2v5h-2zm-5 0h2v5h-2z"/></svg>',
    x:'<svg viewBox="0 0 24 24"><path d="M18.2 2h3.4l-7.4 8.5L23 22h-6.8l-5.3-7-6.1 7H1.4l7.9-9L1 2h7l4.8 6.4L18.2 2zm-1.2 18h1.9L7.1 4H5.1L17 20z"/></svg>',
    instagram:'<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4zM17.3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zM12 2c-2.7 0-3 0-4.1.1C4.4 2.3 2.3 4.4 2.1 7.9 2 9 2 9.3 2 12s0 3 .1 4.1c.2 3.5 2.3 5.6 5.8 5.8 1.1.1 1.4.1 4.1.1s3 0 4.1-.1c3.5-.2 5.6-2.3 5.8-5.8.1-1.1.1-1.4.1-4.1s0-3-.1-4.1c-.2-3.5-2.3-5.6-5.8-5.8C15 2 14.7 2 12 2z"/></svg>',
    tiktok:'<svg viewBox="0 0 24 24"><path d="M16.6 5.8A4.3 4.3 0 0 1 15.5 3h-3.1v12.4a2.6 2.6 0 1 1-2.6-2.6c.3 0 .5 0 .8.1V9.7a5.7 5.7 0 1 0 4.9 5.7V9a7.4 7.4 0 0 0 4.3 1.4V7.3a4.3 4.3 0 0 1-3.2-1.5z"/></svg>',
    youtube:'<svg viewBox="0 0 24 24"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8zM9.7 15V9l5.8 3-5.8 3z"/></svg>',
    discord:'<svg viewBox="0 0 24 24"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.5 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.7.1 18.2a19.9 19.9 0 0 0 6 3l1.3-2.1c-.7-.3-1.4-.6-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.8zM8 15.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.6 8 10.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>'
  };

  const SE = {
    handlers: [],
    on(fn){ this.handlers.push(fn); },
    emit(ev){ this.handlers.forEach(h=>{ try{h(ev)}catch(e){console.error(e)} }); },
    connect(){
      const jwt = C.streamElementsJWT;
      if(!jwt || typeof io==='undefined') { console.warn('StreamElements JWT غير موجود — وضع التجربة فقط'); return; }
      const s = io('https://realtime.streamelements.com',{transports:['websocket']});
      s.on('connect',()=>s.emit('authenticate',{method:'jwt',token:jwt}));
      s.on('authenticated',()=>console.log('✅ متصل بـ StreamElements'));
      s.on('unauthorized',e=>console.error('❌ JWT خاطئ',e));
      const handle = raw=>{
        if(!raw) return;
        const t = raw.type || raw.listener;
        const d = raw.data || raw.event || {};
        const map = {follower:'follow',follow:'follow',subscriber:'sub',tip:'tip',cheer:'cheer',raid:'raid',
                     'follower-latest':'follow','subscriber-latest':'sub','tip-latest':'tip','cheer-latest':'cheer','raid-latest':'raid'};
        const type = map[t]; if(!type) return;
        SE.emit({type, name:d.displayName||d.username||d.name||'مجهول', amount:Number(d.amount)||0,
                 message:d.message||'', months:d.amount, gifted:d.gifted});
      };
      s.on('event',handle); s.on('event:test',handle);
    }
  };

  const store = {
    get(k,d){ try{const v=localStorage.getItem('ovl_'+k); return v===null?d:JSON.parse(v)}catch(e){return d} },
    set(k,v){ try{localStorage.setItem('ovl_'+k,JSON.stringify(v))}catch(e){} }
  };

  function socialsHTML(){
    return Object.entries(C.socials||{}).filter(([,v])=>v)
      .map(([k,v])=>`<div class="social glass">${ICONS[k]||''}<span>${v}</span></div>`).join('');
  }
  function particles(el,n=40){
    for(let i=0;i<n;i++){const p=document.createElement('span');
      p.style.left=Math.random()*100+'%';p.style.animationDuration=(6+Math.random()*10)+'s';
      p.style.animationDelay=(-Math.random()*16)+'s';
      if(Math.random()<.3){p.style.background='var(--hot)';p.style.boxShadow='0 0 10px var(--hot)'}
      el.appendChild(p)}
  }
  function fill(){
    document.querySelectorAll('[data-cfg]').forEach(el=>{
      const v = el.dataset.cfg.split('.').reduce((o,k)=>o&&o[k],C); if(v!==undefined) el.textContent=v;});
    const so=document.querySelector('.socials'); if(so) so.innerHTML=socialsHTML();
    const pa=document.querySelector('.particles'); if(pa) particles(pa);
  }
  const esc = s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const params = new URLSearchParams(location.search);

  window.OVL = {C, SE, store, fill, esc, params, ICONS};
  document.addEventListener('DOMContentLoaded', fill);
})();

/* Layl Chat — عميل الواجهة. كل محتوى المستخدم يُعرض عبر عُقد نصّية (آمن ضد XSS). */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const api = (url, opt = {}) => fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opt })
  .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'خطأ'); return d; });

const AVATARS = ['🌙','⭐','🌟','✨','🔥','💜','🦋','🐺','🦉','🌸','👑','🎭','🎮','☕','🌊','🍃','🖤','😎','🥀','⚡'];
const COLORS = ['#7c6cff','#ff6cab','#5ad1c5','#ffb86c','#78d2ff','#b48cff','#ff5d6c','#4ad7a8','#ffd166','#a0e7a0'];
const EMOJIS = ['❤️','🔥','😂','👍','😮','😢','🙏','🌙'];
const THEMES = ['layl','sunset','ocean','forest'];

let me = null, socket = null, rooms = [], currentRoom = null, replyTo = null;
let lastAuthor = null, typingTimer = null, typingUsers = new Set();

/* ───── سماء النجوم ───── */
(function stars(){
  const c = $('#stars'), x = c.getContext('2d'); let w,h,st=[];
  const rs=()=>{w=c.width=innerWidth;h=c.height=innerHeight;st=Array.from({length:90},()=>({x:Math.random()*w,y:Math.random()*h,r:Math.random()*1.4+.2,a:Math.random(),s:Math.random()*.02+.004}));};
  rs(); addEventListener('resize',rs);
  (function loop(){x.clearRect(0,0,w,h);for(const s of st){s.a+=s.s;if(s.a>1||s.a<0)s.s*=-1;x.globalAlpha=Math.abs(s.a);x.fillStyle='#cfc9ff';x.beginPath();x.arc(s.x,s.y,s.r,0,7);x.fill();}requestAnimationFrame(loop);})();
})();

/* ───── أدوات ───── */
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2600);}
function timeStr(ts){return new Date(ts).toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'});}
function esc(s){return s;} // نستخدم عُقد نصّية بدل الإقحام

// بناء نص الرسالة بأمان: نص عادي + منشن + روابط، الكل عبر عُقد DOM
function renderText(container, text){
  const parts = text.split(/(@[a-z0-9_]{3,20}|https?:\/\/[^\s]+)/gi);
  for(const p of parts){
    if(!p) continue;
    if(/^@[a-z0-9_]{3,20}$/i.test(p)){
      const s=document.createElement('span');s.className='mention';s.textContent=p;container.appendChild(s);
    } else if(/^https?:\/\//i.test(p)){
      const a=document.createElement('a');a.href=p;a.target='_blank';a.rel='noopener noreferrer';a.textContent=p;container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(p));
    }
  }
}

/* ───── المصادقة ───── */
$$('.tab').forEach(t=>t.onclick=()=>{
  $$('.tab').forEach(x=>x.classList.toggle('active',x===t));
  $('#form-login').classList.toggle('hidden',t.dataset.tab!=='login');
  $('#form-register').classList.toggle('hidden',t.dataset.tab!=='register');
  $('#gate-error').textContent='';
});
$('#form-login').onsubmit=async e=>{e.preventDefault();const f=e.target;
  try{const d=await api('/api/login',{method:'POST',body:JSON.stringify({username:f.username.value,password:f.password.value})});enter(d.user);}
  catch(err){$('#gate-error').textContent=err.message;}};
$('#form-register').onsubmit=async e=>{e.preventDefault();const f=e.target;
  try{const d=await api('/api/register',{method:'POST',body:JSON.stringify({username:f.username.value,display:f.display.value,password:f.password.value})});enter(d.user);}
  catch(err){$('#gate-error').textContent=err.message;}};

function enter(user){
  me=user;$('#gate').classList.add('hidden');$('#app').classList.remove('hidden');
  renderMe();connect();loadRooms();
  const th=localStorage.getItem('layl-theme');if(th&&THEMES.includes(th))document.body.dataset.theme=th;
}

/* ───── الاتصال اللحظي ───── */
function connect(){
  socket=io({withCredentials:true});
  socket.on('connect_error',()=>toast('تعذّر الاتصال اللحظي'));
  socket.on('banned',()=>{toast('تم حظرك');location.reload();});
  socket.on('msg:new',m=>{if(m.roomId===currentRoom?.id){appendMsg(m);scrollDown();}refreshRoomList();});
  socket.on('msg:update',m=>{if(m.roomId===currentRoom?.id)replaceMsg(m);});
  socket.on('react:update',({id,reactions})=>updateReacts(id,reactions));
  socket.on('system',({roomId,text})=>{if(roomId===currentRoom?.id)appendSystem(text);});
  socket.on('presence',({roomId,users})=>{if(roomId===currentRoom?.id)renderMembers(users);});
  socket.on('typing',({roomId,user,isTyping})=>{if(roomId!==currentRoom?.id)return;isTyping?typingUsers.add(user):typingUsers.delete(user);renderTyping();});
  socket.on('mention',({from,roomId,preview})=>{toast(`🔔 ${from} ذكرك`);beep();});
}

/* ───── الغرف ───── */
async function loadRooms(){const d=await api('/api/rooms');rooms=d.rooms;renderRoomList();if(rooms[0])joinRoom(rooms[0].id);}
async function refreshRoomList(){try{const d=await api('/api/rooms');rooms=d.rooms;renderRoomList();}catch{}}
function renderRoomList(){
  const list=$('#room-list');list.textContent='';
  for(const r of rooms){
    const el=document.createElement('div');el.className='room'+(r.id===currentRoom?.id?' active':'');
    const ic=document.createElement('div');ic.className='room-ic';ic.textContent=r.icon;
    const meta=document.createElement('div');meta.className='room-meta';
    const nm=document.createElement('div');nm.className='room-nm';nm.textContent=r.name;
    const tp=document.createElement('div');tp.className='room-tp';tp.textContent=r.topic||'';
    meta.append(nm,tp);
    const on=document.createElement('div');on.className='room-on';on.textContent=(r.online||0)+' 🟢';
    el.append(ic,meta,on);
    el.onclick=()=>{joinRoom(r.id);closeMobile();};
    list.appendChild(el);
  }
}
function joinRoom(id){
  if(!socket)return;
  socket.emit('room:join',id,res=>{
    if(res?.error)return toast(res.error);
    currentRoom=res.room;replyTo=null;clearReply();typingUsers.clear();renderTyping();
    $('#room-icon').textContent=res.room.icon;$('#room-name').textContent=res.room.name;$('#room-topic').textContent=res.room.topic||'';
    const box=$('#messages');box.textContent='';lastAuthor=null;
    res.messages.forEach(appendMsg);scrollDown();renderRoomList();
  });
}

/* ───── الرسائل ───── */
function appendMsg(m){
  const box=$('#messages');
  if(m.kind==='system'){appendSystem(m.body);return;}
  const grouped = lastAuthor && m.author && lastAuthor===m.author.id && m.kind!=='me';
  const el=document.createElement('div');
  el.className='msg'+(grouped?' grouped':'')+(m.kind==='me'?' me':'');
  el.dataset.id=m.id;el.dataset.author=m.author?.id||'';

  const av=document.createElement('div');av.className='m-av';av.textContent=m.author?.avatar||'👤';
  const body=document.createElement('div');body.className='m-body';

  // اقتباس رد
  if(m.replyTo){const rp=document.createElement('div');rp.className='m-reply';const b=document.createElement('b');b.textContent=m.replyTo.display+': ';rp.appendChild(b);rp.appendChild(document.createTextNode(m.replyTo.deleted?'(محذوفة)':truncate(m.replyTo.body,60)));body.appendChild(rp);}

  const head=document.createElement('div');head.className='m-head';
  const name=document.createElement('span');name.className='m-name';name.textContent=m.author?.display||'مجهول';if(m.author)name.style.color=m.author.color;
  head.appendChild(name);
  if(m.author?.role==='owner'||m.author?.role==='admin'){const b=document.createElement('span');b.className='m-badge '+m.author.role;b.textContent=m.author.role==='owner'?'المالك':'مشرف';head.appendChild(b);}
  if(m.author){const lv=document.createElement('span');lv.className='m-lvl';lv.textContent='Lv.'+m.author.level;head.appendChild(lv);}
  const tm=document.createElement('span');tm.className='m-time';tm.textContent=timeStr(m.createdAt);head.appendChild(tm);
  body.appendChild(head);

  const text=document.createElement('div');text.className='m-text';
  if(m.deleted){text.className='m-text m-deleted';text.textContent='حُذفت هذه الرسالة';}
  else{if(m.kind==='me'){const pre=document.createElement('span');pre.textContent=(m.author?.display||'')+' ';text.appendChild(pre);}renderText(text,m.body);if(m.edited){const e=document.createElement('span');e.className='m-edited';e.textContent=' (مُعدّلة)';text.appendChild(e);}}
  body.appendChild(text);

  // تفاعلات
  const rc=document.createElement('div');rc.className='m-reacts';rc.dataset.for=m.id;body.appendChild(rc);
  if(m.reactions?.length)paintReacts(rc,m.reactions);

  // أزرار
  if(!m.deleted){
    const act=document.createElement('div');act.className='m-actions';
    const bReact=mkBtn('😀',()=>openEmoji(m.id,bReact));
    const bReply=mkBtn('↩',()=>setReply(m));
    act.append(bReact,bReply);
    if(m.author&&m.author.id===me.id){act.appendChild(mkBtn('✏',()=>editMsg(m)));}
    if((m.author&&m.author.id===me.id)||me.role==='owner'||me.role==='admin'){act.appendChild(mkBtn('🗑',()=>{if(confirm('حذف الرسالة؟'))socket.emit('msg:delete',{id:m.id},r=>r?.error&&toast(r.error));}));}
    el.appendChild(act);
  }

  el.append(av,body);
  box.appendChild(el);
  lastAuthor=m.kind==='me'?null:(m.author?.id||null);
}
function mkBtn(txt,fn){const b=document.createElement('button');b.textContent=txt;b.onclick=fn;return b;}
function truncate(s,n){s=s||'';return s.length>n?s.slice(0,n)+'…':s;}
function appendSystem(text){const box=$('#messages');const el=document.createElement('div');el.className='sys';el.textContent=text;box.appendChild(el);lastAuthor=null;scrollDown();}
function replaceMsg(m){const old=$(`.msg[data-id="${m.id}"]`);if(!old)return;const box=$('#messages');const tmp=document.createElement('div');box.appendChild(tmp);lastAuthor=old.previousElementSibling?.dataset.author||null;appendMsg(m);const fresh=box.lastChild;box.insertBefore(fresh,old);old.remove();tmp.remove();}
function paintReacts(container,reactions){container.textContent='';for(const r of reactions){if(!r.count)continue;const b=document.createElement('button');b.className='react'+(r.mine?' mine':'');b.textContent=r.emoji+' '+r.count;b.onclick=()=>socket.emit('react',{id:+container.dataset.for,emoji:r.emoji},x=>x?.error&&toast(x.error));container.appendChild(b);}}
function updateReacts(id,reactions){const rc=$(`.m-reacts[data-for="${id}"]`);if(!rc)return;const withMine=reactions.map(r=>({...r,mine:false}));
  // علّم تفاعلاتي بصريًا (نحتفظ بها محليًا حسب نقراتي)
  paintReacts(rc,withMine.map(r=>({...r,mine:myReacts.has(id+r.emoji)})));}
const myReacts=new Set();

function scrollDown(){const b=$('#messages');b.scrollTop=b.scrollHeight;}

/* ───── الإرسال / الكتابة ───── */
const input=$('#input');
input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,140)+'px';socket?.emit('typing',true);clearTimeout(typingTimer);typingTimer=setTimeout(()=>socket?.emit('typing',false),1500);});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#composer').requestSubmit();}});
$('#composer').onsubmit=e=>{e.preventDefault();const body=input.value.trim();if(!body)return;
  socket.emit('msg:send',{body,replyTo:replyTo?.id||null},res=>{if(res?.error)toast(res.error);else bumpXp(res.xp);});
  input.value='';input.style.height='auto';clearReply();socket.emit('typing',false);};

function setReply(m){replyTo=m;$('#reply-chip').classList.remove('hidden');$('#reply-name').textContent=m.author?.display||'';$('#reply-text').textContent=truncate(m.body,50);input.focus();}
function clearReply(){replyTo=null;$('#reply-chip').classList.add('hidden');}
$('#reply-cancel').onclick=clearReply;

function editMsg(m){const nb=prompt('تعديل الرسالة:',m.body);if(nb==null)return;socket.emit('msg:edit',{id:m.id,body:nb},r=>r?.error&&toast(r.error));}

function renderTyping(){const t=$('#typing');const arr=[...typingUsers];if(!arr.length){t.className='typing';t.textContent='';return;}t.className='typing on';t.textContent=arr.length===1?`${arr[0]} يكتب`:`${arr.length} أشخاص يكتبون`;}

/* ───── تفاعلات الإيموجي ───── */
function openEmoji(msgId,anchor){const pop=$('#emoji-pop');pop.textContent='';for(const e of EMOJIS){const s=document.createElement('span');s.textContent=e;s.onclick=()=>{socket.emit('react',{id:msgId,emoji:e},r=>{if(r?.error)return toast(r.error);const k=msgId+e;myReacts.has(k)?myReacts.delete(k):myReacts.add(k);});pop.classList.add('hidden');};pop.appendChild(s);}
  const r=anchor.getBoundingClientRect();pop.style.top=(r.bottom+6)+'px';pop.style.left=Math.max(10,r.left-80)+'px';pop.classList.remove('hidden');}
$('#btn-emoji').onclick=()=>{const pop=$('#emoji-pop');pop.textContent='';const common=['😀','😂','❤️','🔥','🌙','✨','👍','🙏','😢','😮','🥺','😎','🤔','🎉','💜','👀'];for(const e of common){const s=document.createElement('span');s.textContent=e;s.onclick=()=>{input.value+=e;input.focus();pop.classList.add('hidden');};pop.appendChild(s);}const r=$('#btn-emoji').getBoundingClientRect();pop.style.top=(r.top-150)+'px';pop.style.left=r.left+'px';pop.style.width='230px';pop.classList.remove('hidden');};
document.addEventListener('click',e=>{if(!e.target.closest('#emoji-pop')&&!e.target.closest('#btn-emoji')&&!e.target.closest('.m-actions'))$('#emoji-pop').classList.add('hidden');});

/* ───── المتواجدون + الإشراف ───── */
function renderMembers(users){
  $('#online-count').textContent=users.length;
  const list=$('#members-list');list.textContent='';
  users.sort((a,b)=>({owner:0,admin:1,member:2}[a.role]-{owner:0,admin:1,member:2}[b.role])||b.level-a.level);
  for(const u of users){
    const el=document.createElement('div');el.className='member';
    const av=document.createElement('div');av.className='m-av';av.textContent=u.avatar;av.style.background='transparent';
    const info=document.createElement('div');info.className='member-info';
    const nm=document.createElement('div');nm.className='member-nm';const dot=document.createElement('span');dot.className='dot';const nmt=document.createElement('span');nmt.textContent=u.display;nmt.style.color=u.color;nm.append(dot,nmt);
    if(u.role==='owner'||u.role==='admin'){const b=document.createElement('span');b.className='m-badge '+u.role;b.textContent=u.role==='owner'?'👑':'🛡';nm.appendChild(b);}
    const vibe=document.createElement('div');vibe.className='member-vibe';vibe.textContent=u.vibe?u.vibe:'Lv.'+u.level;
    info.append(nm,vibe);el.append(av,info);
    // قائمة إشراف للمالك/المشرف
    if((me.role==='owner'||me.role==='admin')&&u.id!==me.id&&u.role!=='owner'){
      el.onclick=()=>openModMenu(el,u);
    }
    list.appendChild(el);
  }
}
function openModMenu(anchor,u){
  $$('.mod-menu').forEach(x=>x.remove());
  const m=document.createElement('div');m.className='mod-menu';
  m.appendChild(mkBtn('🔇 كتم 5 د',()=>{socket.emit('mod:mute',{userId:u.id,minutes:5},r=>toast(r?.error||'تم الكتم'));m.remove();}));
  m.appendChild(mkBtn('⛔ حظر',()=>{if(confirm('حظر '+u.display+'؟'))socket.emit('mod:ban',{userId:u.id},r=>toast(r?.error||'تم الحظر'));m.remove();}));
  if(me.role==='owner'){
    m.appendChild(mkBtn(u.role==='admin'?'↓ إزالة إشراف':'↑ ترقية لمشرف',()=>{socket.emit('mod:role',{userId:u.id,role:u.role==='admin'?'member':'admin'},r=>toast(r?.error||'تم'));m.remove();}));
  }
  anchor.appendChild(m);
  setTimeout(()=>document.addEventListener('click',function h(e){if(!m.contains(e.target)){m.remove();document.removeEventListener('click',h);}}),0);
}

/* ───── الملف الشخصي + XP ───── */
function renderMe(){
  $('#me-av').textContent=me.avatar;$('#me-name').textContent=me.display;$('#me-lvl').textContent='Lv.'+me.level;
  const span=Math.max(1,me.nextLevelXp-me.thisLevelXp);const prog=Math.min(100,Math.max(0,(me.xp-me.thisLevelXp)/span*100));
  $('#me-xp-fill').style.width=prog+'%';
}
function bumpXp(gain){if(!gain)return;me.xp+=gain;const nl=Math.max(1,Math.floor(0.25*Math.sqrt(me.xp))+1);
  if(nl>me.level){me.level=nl;me.thisLevelXp=Math.ceil(Math.pow((nl-1)/0.25,2));me.nextLevelXp=Math.ceil(Math.pow((nl)/0.25,2));toast('🎉 وصلت للمستوى '+nl+'!');beep();}
  renderMe();}

$('#btn-profile').onclick=()=>{
  const ap=$('#avatar-pick');ap.textContent='';AVATARS.forEach(a=>{const s=document.createElement('span');s.textContent=a;if(a===me.avatar)s.classList.add('sel');s.onclick=()=>{$$('#avatar-pick span').forEach(x=>x.classList.remove('sel'));s.classList.add('sel');};ap.appendChild(s);});
  const cp=$('#color-pick');cp.textContent='';COLORS.forEach(c=>{const s=document.createElement('span');s.style.background=c;if(c===me.color)s.classList.add('sel');s.onclick=()=>{$$('#color-pick span').forEach(x=>x.classList.remove('sel'));s.classList.add('sel');};cp.appendChild(s);});
  $('#pf-display').value=me.display;$('#pf-vibe').value=me.vibe||'';$('#pf-bio').value=me.bio||'';
  $('#modal-profile').classList.remove('hidden');
};
$('#pf-save').onclick=async()=>{
  const avatar=$('#avatar-pick .sel')?.textContent||me.avatar;
  const color=$('#color-pick .sel')?.style.background||me.color;
  const hex=rgbToHex(color);
  try{const d=await api('/api/me',{method:'PUT',body:JSON.stringify({display:$('#pf-display').value,avatar,color:hex,vibe:$('#pf-vibe').value,bio:$('#pf-bio').value})});
    Object.assign(me,d.user);renderMe();$('#modal-profile').classList.add('hidden');toast('تم الحفظ');}
  catch(e){toast(e.message);}
};
$('#pf-logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload();};
function rgbToHex(c){if(c.startsWith('#'))return c;const m=c.match(/\d+/g);if(!m)return me.color;return '#'+m.slice(0,3).map(n=>(+n).toString(16).padStart(2,'0')).join('');}

/* ───── غرفة جديدة ───── */
$('#btn-newroom').onclick=()=>{
  const p=$('#room-icon-pick');p.textContent='';['💬','🌙','✨','🎮','☕','🎵','📚','🔥','💜','🌊','🎭','⚽'].forEach((a,i)=>{const s=document.createElement('span');s.textContent=a;if(i===0)s.classList.add('sel');s.onclick=()=>{$$('#room-icon-pick span').forEach(x=>x.classList.remove('sel'));s.classList.add('sel');};p.appendChild(s);});
  $('#nr-name').value='';$('#nr-topic').value='';$('#modal-room').classList.remove('hidden');
};
$('#nr-create').onclick=async()=>{
  const icon=$('#room-icon-pick .sel')?.textContent||'💬';
  try{const d=await api('/api/rooms',{method:'POST',body:JSON.stringify({name:$('#nr-name').value,topic:$('#nr-topic').value,icon})});
    $('#modal-room').classList.add('hidden');await refreshRoomList();joinRoom(d.room.id);toast('تم إنشاء الغرفة');}
  catch(e){toast(e.message);}
};
// غرفة أنشأها غيرك
if(window.io){} // socket room:new
document.addEventListener('DOMContentLoaded',()=>{});

/* ───── البحث ───── */
$('#btn-search').onclick=()=>{$('#search-bar').classList.toggle('hidden');$('#search-input').focus();};
$('#search-close').onclick=()=>{$('#search-bar').classList.add('hidden');$('#search-input').value='';joinRoom(currentRoom.id);};
let searchT;$('#search-input').oninput=e=>{clearTimeout(searchT);const q=e.target.value.trim();searchT=setTimeout(async()=>{
  if(!q)return;try{const d=await api(`/api/rooms/${currentRoom.id}/messages?q=${encodeURIComponent(q)}`);const box=$('#messages');box.textContent='';lastAuthor=null;if(!d.messages.length)appendSystem('لا نتائج');d.messages.forEach(appendMsg);}catch{}},300);};

/* ───── ثيم + جوال + صوت ───── */
$('#btn-theme').onclick=()=>{const i=THEMES.indexOf(document.body.dataset.theme);const next=THEMES[(i+1)%THEMES.length];document.body.dataset.theme=next;localStorage.setItem('layl-theme',next);toast('الثيم: '+next);};
$('#btn-menu').onclick=()=>$('#side').classList.add('open');
$('#btn-members').onclick=()=>$('#members').classList.toggle('open');
$('#members-close').onclick=()=>$('#members').classList.remove('open');
function closeMobile(){$('#side').classList.remove('open');}
document.addEventListener('click',e=>{if(e.target.closest('#side')||e.target.closest('#btn-menu'))return;if(innerWidth<=900)$('#side').classList.remove('open');});
$$('.modal-close').forEach(b=>b.onclick=()=>b.closest('.modal').classList.add('hidden'));
$$('.modal').forEach(m=>m.onclick=e=>{if(e.target===m)m.classList.add('hidden');});

let audioCtx;function beep(){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=660;o.type='sine';g.gain.setValueAtTime(.08,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.3);o.start();o.stop(audioCtx.currentTime+.3);}catch{}}

// تحديث قائمة الغرف عند إنشاء غرفة من مستخدم آخر
const _connect=connect;connect=function(){_connect();socket.on('room:new',()=>refreshRoomList());};

/* ───── إقلاع: جلسة سابقة؟ ───── */
api('/api/me').then(d=>enter(d.user)).catch(()=>{/* أظهر البوابة */});
})();

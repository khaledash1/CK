/* Layl Chat v2 — عميل الواجهة + صوت WebRTC. محتوى المستخدم يُعرض عبر عُقد نصّية (آمن ضد XSS). */
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
const COUNTRIES = {SA:'السعودية',AE:'الإمارات',KW:'الكويت',QA:'قطر',BH:'البحرين',OM:'عُمان',YE:'اليمن',EG:'مصر',JO:'الأردن',IQ:'العراق',SY:'سوريا',LB:'لبنان',PS:'فلسطين',MA:'المغرب',DZ:'الجزائر',TN:'تونس',LY:'ليبيا',SD:'السودان',OTHER:'أخرى'};
const flag = c => c && c !== 'OTHER' && /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map(x => 0x1F1E6 + x.charCodeAt(0) - 65)) : '🌐';

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let me = null, socket = null, mySocketId = null, currentRoom = null, replyTo = null;
let lastAuthor = null, typingTimer = null, typingUsers = new Set(), presence = [];
let currentSeats = [], dmPeer = null;
// صوت
let localStream = null, iAmSpeaker = false, micMuted = false, speakerMuted = false;
const sendPcs = new Map(), recvPcs = new Map(), remoteAudios = new Map();
const myReacts = new Set();

/* ───── سماء النجوم ───── */
(function stars(){const c=$('#stars'),x=c.getContext('2d');let w,h,st=[];
  const rs=()=>{w=c.width=innerWidth;h=c.height=innerHeight;st=Array.from({length:90},()=>({x:Math.random()*w,y:Math.random()*h,r:Math.random()*1.4+.2,a:Math.random(),s:Math.random()*.02+.004}));};
  rs();addEventListener('resize',rs);(function loop(){x.clearRect(0,0,w,h);for(const s of st){s.a+=s.s;if(s.a>1||s.a<0)s.s*=-1;x.globalAlpha=Math.abs(s.a);x.fillStyle='#cfc9ff';x.beginPath();x.arc(s.x,s.y,s.r,0,7);x.fill();}requestAnimationFrame(loop);})();})();

/* ───── أدوات ───── */
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2600);}
const timeStr=ts=>new Date(ts).toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'});
const truncate=(s,n)=>{s=s||'';return s.length>n?s.slice(0,n)+'…':s;};
function renderText(c,text){for(const p of text.split(/(@[a-z0-9_]{3,20}|https?:\/\/[^\s]+)/gi)){if(!p)continue;
  if(/^@[a-z0-9_]{3,20}$/i.test(p)){const s=document.createElement('span');s.className='mention';s.textContent=p;c.appendChild(s);}
  else if(/^https?:\/\//i.test(p)){const a=document.createElement('a');a.href=p;a.target='_blank';a.rel='noopener noreferrer';a.textContent=p;c.appendChild(a);}
  else c.appendChild(document.createTextNode(p));}}
function mkBtn(t,fn,cls){const b=document.createElement('button');b.textContent=t;if(cls)b.className=cls;b.onclick=fn;return b;}
function fillCountry(sel){sel.textContent='';for(const[k,v]of Object.entries(COUNTRIES)){const o=document.createElement('option');o.value=k;o.textContent=flag(k)+' '+v;sel.appendChild(o);}}
fillCountry($('#reg-country'));fillCountry($('#pf-country'));

/* ───── المصادقة ───── */
$$('.tab').forEach(t=>t.onclick=()=>{$$('.tab').forEach(x=>x.classList.toggle('active',x===t));
  $('#form-login').classList.toggle('hidden',t.dataset.tab!=='login');$('#form-register').classList.toggle('hidden',t.dataset.tab!=='register');$('#gate-error').textContent='';});
$('#form-login').onsubmit=async e=>{e.preventDefault();const f=e.target;try{const d=await api('/api/login',{method:'POST',body:JSON.stringify({username:f.username.value,password:f.password.value})});enter(d.user);}catch(err){$('#gate-error').textContent=err.message;}};
$('#form-register').onsubmit=async e=>{e.preventDefault();const f=e.target;try{const d=await api('/api/register',{method:'POST',body:JSON.stringify({username:f.username.value,display:f.display.value,country:f.country.value,password:f.password.value})});enter(d.user);}catch(err){$('#gate-error').textContent=err.message;}};

function enter(user){me=user;$('#gate').classList.add('hidden');$('#app').classList.remove('hidden');
  renderMe();connect();loadRooms();refreshDmBadge();loadStories();
  const th=localStorage.getItem('layl-theme');if(th&&THEMES.includes(th))document.body.dataset.theme=th;}

/* ───── الاتصال ───── */
function connect(){
  socket=io({withCredentials:true});
  socket.on('ready',({socketId})=>mySocketId=socketId);
  socket.on('connect_error',()=>toast('تعذّر الاتصال اللحظي'));
  socket.on('banned',()=>{toast('تم حظرك');setTimeout(()=>location.reload(),800);});
  socket.on('msg:new',m=>{if(m.roomId===currentRoom?.id){appendMsg(m);scrollDown();}refreshRoomList();});
  socket.on('msg:update',m=>{if(m.roomId===currentRoom?.id)replaceMsg(m);});
  socket.on('react:update',({id,reactions})=>updateReacts(id,reactions));
  socket.on('system',({roomId,text})=>{if(roomId===currentRoom?.id)appendSystem(text);});
  socket.on('presence',({roomId,users})=>{if(roomId===currentRoom?.id){presence=users;renderMembers(users);reconcileVoice();pruneDeadPeers();}});
  socket.on('typing',({roomId,user,isTyping})=>{if(roomId!==currentRoom?.id)return;isTyping?typingUsers.add(user):typingUsers.delete(user);renderTyping();});
  socket.on('mention',({from})=>{toast(`🔔 ${from} ذكرك`);beep();});
  socket.on('notify',({text})=>{toast(text);beep();});
  socket.on('room:new',()=>refreshRoomList());
  socket.on('wall:new',p=>{if($('#modal-wall').classList.contains('hidden'))return;prependWall(p);});
  socket.on('wall:like',({id,likes})=>{const el=$(`.wall-like[data-id="${id}"]`);if(el)el.querySelector('span').textContent=likes;});
  socket.on('wall:del',({id})=>{$(`.wall-post[data-id="${id}"]`)?.remove();});
  socket.on('dm:new',m=>{refreshDmBadge();if(dmPeer&&m.from===dmPeer.id&&!$('#modal-dm').classList.contains('hidden')){appendDM(m);socket.emit('dm:send'/*noop*/);}else{toast(`✉️ ${m.author?.display||''}: ${truncate(m.body,40)}`);beep();}});
  // voice
  socket.on('voice:seats',({roomId,seats})=>{if(roomId===currentRoom?.id){currentSeats=seats;renderSeats(seats);}});
  socket.on('voice:speaking',({userId,speaking})=>{const s=$(`.seat[data-uid="${userId}"]`);if(s)s.classList.toggle('speaking',speaking);});
  socket.on('voice:offer',onVoiceOffer);
  socket.on('voice:answer',onVoiceAnswer);
  socket.on('voice:ice',onVoiceIce);
  socket.on('voice:peerleft',({socketId})=>closePeer(socketId));
  socket.on('story:new',()=>loadStories());
  socket.on('story:del',()=>loadStories());
}

/* ───── الغرف ───── */
async function loadRooms(){const d=await api('/api/rooms');window._rooms=d.rooms;renderRoomList();if(d.rooms[0])joinRoom(d.rooms[0].id);}
async function refreshRoomList(){try{const d=await api('/api/rooms');window._rooms=d.rooms;renderRoomList();if(!$('#modal-rooms').classList.contains('hidden'))renderRoomsGrid();}catch{}}
function renderRoomList(){const list=$('#room-list');list.textContent='';for(const r of(window._rooms||[])){
  const el=document.createElement('div');el.className='room'+(r.id===currentRoom?.id?' active':'');
  const ic=document.createElement('div');ic.className='room-ic';ic.textContent=r.icon;
  const meta=document.createElement('div');meta.className='room-meta';
  const nm=document.createElement('div');nm.className='room-nm';nm.textContent=(r.kind==='voice'?'🎙️ ':'')+r.name;
  const tp=document.createElement('div');tp.className='room-tp';tp.textContent=r.topic||'';meta.append(nm,tp);
  const on=document.createElement('div');on.className='room-on';on.textContent=(r.online||0)+'/'+r.capacity;
  el.append(ic,meta,on);el.onclick=()=>{joinRoom(r.id);closeDrawers();};list.appendChild(el);}}

function joinRoom(id){if(!socket)return;teardownVoice();
  socket.emit('room:join',id,res=>{if(res?.error)return toast(res.error);
    currentRoom=res.room;replyTo=null;clearReply();typingUsers.clear();renderTyping();
    $('#room-icon').textContent=res.room.icon;$('#room-name').textContent=res.room.name;$('#room-topic').textContent=res.room.topic||'';
    const box=$('#messages');box.textContent='';lastAuthor=null;res.messages.forEach(appendMsg);
    if(res.room.welcome)appendSystem(res.room.welcome);scrollDown();renderRoomList();
    // منصة الصوت
    const isVoice=res.room.kind==='voice';
    $('#stage').classList.toggle('hidden',!isVoice);
    currentSeats=res.voiceSeats||[];if(isVoice)renderSeats(currentSeats);
    resetMicUI();
  });}

/* ───── الرسائل ───── */
function appendMsg(m){const box=$('#messages');if(m.kind==='system'){appendSystem(m.body);return;}
  const grouped=lastAuthor&&m.author&&lastAuthor===m.author.id&&m.kind!=='me';
  const el=document.createElement('div');el.className='msg'+(grouped?' grouped':'')+(m.kind==='me'?' me':'');
  el.dataset.id=m.id;el.dataset.author=m.author?.id||'';
  const av=document.createElement('div');av.className='m-av';av.textContent=m.author?.avatar||'👤';
  if(m.author)av.onclick=()=>openProfileCard(m.author.id);av.style.cursor='pointer';
  const body=document.createElement('div');body.className='m-body';
  if(m.replyTo){const rp=document.createElement('div');rp.className='m-reply';const b=document.createElement('b');b.textContent=m.replyTo.display+': ';rp.appendChild(b);rp.appendChild(document.createTextNode(m.replyTo.deleted?'(محذوفة)':truncate(m.replyTo.body,60)));body.appendChild(rp);}
  const head=document.createElement('div');head.className='m-head';
  const name=document.createElement('span');name.className='m-name';name.textContent=m.author?.display||'مجهول';if(m.author){name.style.color=m.author.color;name.style.cursor='pointer';name.onclick=()=>openProfileCard(m.author.id);}
  head.appendChild(name);
  if(m.author)head.appendChild(flagEl(m.author.country));
  if(m.author?.role==='owner'||m.author?.role==='admin'){const b=document.createElement('span');b.className='m-badge '+m.author.role;b.textContent=m.author.role==='owner'?'👑':'🛡';head.appendChild(b);}
  if(m.author){const lv=document.createElement('span');lv.className='m-lvl';lv.textContent='Lv.'+m.author.level;head.appendChild(lv);}
  const tm=document.createElement('span');tm.className='m-time';tm.textContent=timeStr(m.createdAt);head.appendChild(tm);body.appendChild(head);
  const text=document.createElement('div');text.className='m-text';
  if(m.deleted){text.className='m-text m-deleted';text.textContent='حُذفت هذه الرسالة';}
  else{if(m.kind==='me'){const pre=document.createElement('span');pre.textContent=(m.author?.display||'')+' ';text.appendChild(pre);}renderText(text,m.body);if(m.edited){const e=document.createElement('span');e.className='m-edited';e.textContent=' (مُعدّلة)';text.appendChild(e);}}
  body.appendChild(text);
  const rc=document.createElement('div');rc.className='m-reacts';rc.dataset.for=m.id;body.appendChild(rc);if(m.reactions?.length)paintReacts(rc,m.reactions);
  if(!m.deleted){const act=document.createElement('div');act.className='m-actions';
    act.append(mkBtn('😀',()=>openEmoji(m.id,act)),mkBtn('↩',()=>setReply(m)));
    if(m.author&&m.author.id===me.id)act.appendChild(mkBtn('✏',()=>editMsg(m)));
    if((m.author&&m.author.id===me.id)||me.role==='owner'||me.role==='admin')act.appendChild(mkBtn('🗑',()=>{if(confirm('حذف الرسالة؟'))socket.emit('msg:delete',{id:m.id},r=>r?.error&&toast(r.error));}));
    el.appendChild(act);}
  el.append(av,body);box.appendChild(el);lastAuthor=m.kind==='me'?null:(m.author?.id||null);}
function flagEl(c){const s=document.createElement('span');s.className='flag';s.textContent=flag(c);s.title=COUNTRIES[c]||'';return s;}
function appendSystem(t){const box=$('#messages');const el=document.createElement('div');el.className='sys';el.textContent=t;box.appendChild(el);lastAuthor=null;scrollDown();}
function replaceMsg(m){const old=$(`.msg[data-id="${m.id}"]`);if(!old)return;const box=$('#messages');lastAuthor=old.previousElementSibling?.dataset.author||null;appendMsg(m);const fresh=box.lastChild;box.insertBefore(fresh,old);old.remove();}
function paintReacts(c,rx){c.textContent='';for(const r of rx){if(!r.count)continue;const b=document.createElement('button');b.className='react'+(r.mine?' mine':'');b.textContent=r.emoji+' '+r.count;b.onclick=()=>socket.emit('react',{id:+c.dataset.for,emoji:r.emoji},x=>x?.error&&toast(x.error));c.appendChild(b);}}
function updateReacts(id,rx){const rc=$(`.m-reacts[data-for="${id}"]`);if(rc)paintReacts(rc,rx.map(r=>({...r,mine:myReacts.has(id+r.emoji)})));}
function scrollDown(){const b=$('#messages');b.scrollTop=b.scrollHeight;}

/* ───── الإرسال ───── */
const input=$('#input');
input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,140)+'px';socket?.emit('typing',true);clearTimeout(typingTimer);typingTimer=setTimeout(()=>socket?.emit('typing',false),1500);});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#composer').requestSubmit();}});
$('#composer').onsubmit=e=>{e.preventDefault();const body=input.value.trim();if(!body)return;socket.emit('msg:send',{body,replyTo:replyTo?.id||null},res=>{if(res?.error)toast(res.error);else bumpXp(res.xp);});input.value='';input.style.height='auto';clearReply();socket.emit('typing',false);};
function setReply(m){replyTo=m;$('#reply-chip').classList.remove('hidden');$('#reply-name').textContent=m.author?.display||'';$('#reply-text').textContent=truncate(m.body,50);input.focus();}
function clearReply(){replyTo=null;$('#reply-chip').classList.add('hidden');}
$('#reply-cancel').onclick=clearReply;
function editMsg(m){const nb=prompt('تعديل:',m.body);if(nb==null)return;socket.emit('msg:edit',{id:m.id,body:nb},r=>r?.error&&toast(r.error));}
function renderTyping(){const t=$('#typing');const a=[...typingUsers];if(!a.length){t.className='typing';t.textContent='';return;}t.className='typing on';t.textContent=a.length===1?`${a[0]} يكتب`:`${a.length} يكتبون`;}

/* ───── إيموجي ───── */
function openEmoji(id,anchor){const pop=$('#emoji-pop');pop.textContent='';for(const e of EMOJIS){const s=document.createElement('span');s.textContent=e;s.onclick=()=>{socket.emit('react',{id,emoji:e},r=>{if(r?.error)return toast(r.error);const k=id+e;myReacts.has(k)?myReacts.delete(k):myReacts.add(k);});pop.classList.add('hidden');};pop.appendChild(s);}const r=anchor.getBoundingClientRect();pop.style.top=(r.bottom+6)+'px';pop.style.left=Math.max(10,r.left-60)+'px';pop.style.width='200px';pop.classList.remove('hidden');}
$('#btn-emoji').onclick=()=>{const pop=$('#emoji-pop');pop.textContent='';for(const e of ['😀','😂','❤️','🔥','🌙','✨','👍','🙏','😢','😮','🥺','😎','🤔','🎉','💜','👀']){const s=document.createElement('span');s.textContent=e;s.onclick=()=>{input.value+=e;input.focus();pop.classList.add('hidden');};pop.appendChild(s);}const r=$('#btn-emoji').getBoundingClientRect();pop.style.top=(r.top-160)+'px';pop.style.left=r.left+'px';pop.style.width='230px';pop.classList.remove('hidden');};
document.addEventListener('click',e=>{if(!e.target.closest('#emoji-pop')&&!e.target.closest('#btn-emoji')&&!e.target.closest('.m-actions'))$('#emoji-pop').classList.add('hidden');});

/* ───── المتواجدون ───── */
function renderMembers(users){$('#online-count').textContent=users.length;$('#members-count').textContent=users.length;
  const list=$('#members-list');list.textContent='';
  users.sort((a,b)=>({owner:0,admin:1,member:2}[a.role]-{owner:0,admin:1,member:2}[b.role])||b.likes-a.likes);
  for(const u of users){const el=document.createElement('div');el.className='member';
    const av=document.createElement('div');av.className='m-av';av.textContent=u.avatar;av.style.background='transparent';
    const info=document.createElement('div');info.className='member-info';
    const nm=document.createElement('div');nm.className='member-nm';const dot=document.createElement('span');dot.className='dot';const t=document.createElement('span');t.textContent=u.display;t.style.color=u.color;nm.append(dot,t,flagEl(u.country));
    if(u.role==='owner'||u.role==='admin'){const b=document.createElement('span');b.className='m-badge '+u.role;b.textContent=u.role==='owner'?'👑':'🛡';nm.appendChild(b);}
    const sub=document.createElement('div');sub.className='member-vibe';sub.textContent=(u.vibe?u.vibe+' · ':'')+'Lv.'+u.level+(u.likes?' · ❤️'+u.likes:'');
    info.append(nm,sub);el.append(av,info);el.onclick=()=>openProfileCard(u.id);list.appendChild(el);}}

/* ───── بطاقة بروفايل ───── */
async function openProfileCard(id){try{const{user}=await api('/api/users/'+id);const u=user;
  $('#pc-av').textContent=u.avatar;$('#pc-name').textContent=u.display;$('#pc-name').style.color=u.color;
  $('#pc-sub').textContent='@'+u.username+(u.role!=='member'?(u.role==='owner'?' · 👑 المالك':' · 🛡 مشرف'):'');
  $('#pc-level').textContent='Lv.'+u.level;$('#pc-likes').textContent='❤️ '+u.likes;$('#pc-flag').textContent=flag(u.country)+' '+(COUNTRIES[u.country]||'');
  $('#pc-bio').textContent=u.bio||'لا توجد نبذة';
  const soc=$('#pc-social');soc.textContent='';const map={twitter:'𝕏 تويتر',instagram:'📸 انستقرام',snapchat:'👻 سناب',tiktok:'🎵 تيك توك',youtube:'▶️ يوتيوب'};
  for(const[k,label]of Object.entries(map)){if(u.social?.[k]){const a=document.createElement('a');a.textContent=label;a.href=socialUrl(k,u.social[k]);a.target='_blank';a.rel='noopener noreferrer';soc.appendChild(a);}}
  const act=$('#pc-actions');act.textContent='';
  if(u.id!==me.id){
    act.appendChild(mkBtn((u.likedByMe?'❤️ ملغى':'🤍 إعجاب'),function(){socket.emit('user:like',{userId:u.id},r=>{if(r?.error)return toast(r.error);this.textContent=r.likedByMe?'❤️ ملغى':'🤍 إعجاب';this.classList.toggle('liked',r.likedByMe);$('#pc-likes').textContent='❤️ '+r.likes;});},u.likedByMe?'liked':''));
    act.appendChild(mkBtn('✉️ خاص',()=>{closeModal('#modal-card');openDM(u);},'primary'));
    if(me.role==='owner'||me.role==='admin'){
      act.appendChild(mkBtn('🔇 كتم',()=>socket.emit('mod:mute',{userId:u.id,minutes:5},r=>toast(r?.error||'تم'))));
      act.appendChild(mkBtn('🎤⬇ إنزال',()=>socket.emit('mod:kickmic',{userId:u.id},r=>toast(r?.error||'تم'))));
      act.appendChild(mkBtn('⛔ حظر',()=>{if(confirm('حظر؟'))socket.emit('mod:ban',{userId:u.id},r=>toast(r?.error||'تم'));}));
      if(me.role==='owner')act.appendChild(mkBtn(u.role==='admin'?'↓ عضو':'↑ مشرف',()=>socket.emit('mod:role',{userId:u.id,role:u.role==='admin'?'member':'admin'},r=>toast(r?.error||'تم'))));
    }
  }
  $('#modal-card').classList.remove('hidden');
}catch(e){toast(e.message);}}
function socialUrl(k,v){v=v.replace(/^@/,'');return{twitter:'https://x.com/'+v,instagram:'https://instagram.com/'+v,snapchat:'https://snapchat.com/add/'+v,tiktok:'https://tiktok.com/@'+v,youtube:v.startsWith('http')?v:'https://youtube.com/@'+v}[k];}

/* ───── الصوت: المقاعد والواجهة ───── */
function renderSeats(seats){const g=$('#seats');g.textContent='';seats.forEach((s,i)=>{
  const el=document.createElement('div');el.className='seat '+(s?'filled':'empty');el.dataset.idx=i;if(s){el.dataset.uid=s.userId;if(s.speaking)el.classList.add('speaking');}
  const av=document.createElement('div');av.className='seat-av';av.textContent=s?s.avatar:'➕';
  const num=document.createElement('span');num.className='seat-num';num.textContent=i+1;av.appendChild(num);
  if(s&&s.muted){const mu=document.createElement('span');mu.className='seat-mute';mu.textContent='🔇';av.appendChild(mu);}
  const nm=document.createElement('div');nm.className='seat-name';nm.textContent=s?s.display:'اصعد';
  el.append(av,nm);
  el.onclick=()=>{if(s){openProfileCard(s.userId);}else{takeMic(i);}};
  g.appendChild(el);});}

async function takeMic(seatIndex){
  if(iAmSpeaker)return;
  try{localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});}
  catch(e){return toast('تعذّر الوصول للمايك — اسمح بالإذن');}
  socket.emit('mic:take',{seatIndex},res=>{
    if(res?.error){toast(res.error);localStream.getTracks().forEach(t=>t.stop());localStream=null;return;}
    iAmSpeaker=true;micMuted=false;startSpeakingMeter();reconcileVoice();setMicUI(true);toast('أنت على المايك 🎙️');
  });
}
function leaveMic(){if(!iAmSpeaker)return;socket.emit('mic:leave');iAmSpeaker=false;stopSpeakingMeter();
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}
  for(const id of[...sendPcs.keys()])closeSendPc(id);setMicUI(false);}
function setMicUI(on){const b=$('#btn-mic');b.textContent=on?'🎙️ انزل من المايك':'🎙️ اصعد المايك';b.classList.toggle('on',on);
  $('#btn-mute').classList.toggle('hidden',!on);$('#mic-hint').textContent=on?'تتحدث الآن':'';}
function resetMicUI(){iAmSpeaker=false;micMuted=false;setMicUI(false);}
$('#btn-mic').onclick=()=>iAmSpeaker?leaveMic():takeMic();
$('#btn-mute').onclick=()=>{if(!localStream)return;micMuted=!micMuted;localStream.getAudioTracks().forEach(t=>t.enabled=!micMuted);$('#btn-mute').textContent=micMuted?'🔇':'🎤';socket.emit('mic:mute',{muted:micMuted});};
$('#btn-speaker').onclick=()=>{speakerMuted=!speakerMuted;for(const a of remoteAudios.values())a.muted=speakerMuted;$('#btn-speaker').textContent=speakerMuted?'🔇':'🔊';toast(speakerMuted?'كتمت السماعات':'شغّلت السماعات');};

/* مؤشّر التحدّث */
let meterCtx,meterRAF,lastSpeak=false;
function startSpeakingMeter(){try{meterCtx=new(window.AudioContext||window.webkitAudioContext)();const src=meterCtx.createMediaStreamSource(localStream);const an=meterCtx.createAnalyser();an.fftSize=512;src.connect(an);const data=new Uint8Array(an.frequencyBinCount);
  const tick=()=>{an.getByteFrequencyData(data);let sum=0;for(const v of data)sum+=v;const avg=sum/data.length;const sp=!micMuted&&avg>12;if(sp!==lastSpeak){lastSpeak=sp;socket.emit('mic:speaking',{speaking:sp});const s=$(`.seat[data-uid="${me.id}"]`);if(s)s.classList.toggle('speaking',sp);}meterRAF=requestAnimationFrame(tick);};tick();}catch{}}
function stopSpeakingMeter(){cancelAnimationFrame(meterRAF);if(meterCtx){meterCtx.close();meterCtx=null;}lastSpeak=false;}

/* ───── WebRTC ───── */
function reconcileVoice(){const targets=iAmSpeaker?presence.map(u=>u.socketId).filter(id=>id&&id!==mySocketId):[];
  for(const id of targets)if(!sendPcs.has(id))createSendPc(id);
  for(const id of[...sendPcs.keys()])if(!targets.includes(id))closeSendPc(id);}
function pruneDeadPeers(){const live=new Set(presence.map(u=>u.socketId));for(const id of[...recvPcs.keys()])if(!live.has(id))closeRecvPc(id);}
function createSendPc(peerId){const pc=new RTCPeerConnection(ICE);sendPcs.set(peerId,pc);
  if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.onicecandidate=e=>{if(e.candidate)socket.emit('voice:ice',{to:peerId,cand:e.candidate,role:'offer'});};
  pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState))closeSendPc(peerId);};
  pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>socket.emit('voice:offer',{to:peerId,sdp:pc.localDescription})).catch(()=>{});}
async function onVoiceOffer({from,sdp}){let pc=recvPcs.get(from);if(!pc){pc=new RTCPeerConnection(ICE);recvPcs.set(from,pc);
  pc.ontrack=e=>attachRemote(from,e.streams[0]);
  pc.onicecandidate=e=>{if(e.candidate)socket.emit('voice:ice',{to:from,cand:e.candidate,role:'answer'});};
  pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState))closeRecvPc(from);};}
  try{await pc.setRemoteDescription(sdp);const a=await pc.createAnswer();await pc.setLocalDescription(a);socket.emit('voice:answer',{to:from,sdp:pc.localDescription});}catch{}}
function onVoiceAnswer({from,sdp}){const pc=sendPcs.get(from);if(pc)pc.setRemoteDescription(sdp).catch(()=>{});}
function onVoiceIce({from,cand,role}){const pc=role==='offer'?recvPcs.get(from):sendPcs.get(from);if(pc&&cand)pc.addIceCandidate(cand).catch(()=>{});}
function attachRemote(id,stream){let a=remoteAudios.get(id);if(!a){a=document.createElement('audio');a.autoplay=true;a.playsInline=true;a.muted=speakerMuted;$('#audio-sink').appendChild(a);remoteAudios.set(id,a);}a.srcObject=stream;a.play?.().catch(()=>{});}
function closeSendPc(id){const pc=sendPcs.get(id);if(pc){pc.close();sendPcs.delete(id);}}
function closeRecvPc(id){const pc=recvPcs.get(id);if(pc){pc.close();recvPcs.delete(id);}const a=remoteAudios.get(id);if(a){a.srcObject=null;a.remove();remoteAudios.delete(id);}}
function closePeer(id){closeSendPc(id);closeRecvPc(id);}
function teardownVoice(){if(iAmSpeaker)leaveMic();for(const id of[...sendPcs.keys()])closeSendPc(id);for(const id of[...recvPcs.keys()])closeRecvPc(id);stopSpeakingMeter();}

/* ───── الملف الشخصي (إعدادات) + XP ───── */
function renderMe(){$('#me-av').textContent=me.avatar;$('#me-name').textContent=me.display;$('#me-lvl').textContent='Lv.'+me.level;
  const span=Math.max(1,me.nextLevelXp-me.thisLevelXp),prog=Math.min(100,Math.max(0,(me.xp-me.thisLevelXp)/span*100));$('#me-xp-fill').style.width=prog+'%';}
function bumpXp(g){if(!g)return;me.xp+=g;const nl=Math.max(1,Math.floor(0.25*Math.sqrt(me.xp))+1);if(nl>me.level){me.level=nl;me.thisLevelXp=Math.ceil(Math.pow((nl-1)/0.25,2));me.nextLevelXp=Math.ceil(Math.pow(nl/0.25,2));toast('🎉 المستوى '+nl+'!');beep();}renderMe();}

$('#btn-profile').onclick=openSettings;$('#nav-profile').onclick=openSettings;
function openSettings(){const ap=$('#avatar-pick');ap.textContent='';AVATARS.forEach(a=>{const s=document.createElement('span');s.textContent=a;if(a===me.avatar)s.classList.add('sel');s.onclick=()=>{$$('#avatar-pick span').forEach(x=>x.classList.remove('sel'));s.classList.add('sel');};ap.appendChild(s);});
  const cp=$('#color-pick');cp.textContent='';COLORS.forEach(c=>{const s=document.createElement('span');s.style.background=c;if(c===me.color)s.classList.add('sel');s.onclick=()=>{$$('#color-pick span').forEach(x=>x.classList.remove('sel'));s.classList.add('sel');};cp.appendChild(s);});
  $('#pf-display').value=me.display;$('#pf-vibe').value=me.vibe||'';$('#pf-bio').value=me.bio||'';$('#pf-country').value=me.country||'SA';
  $('#s-twitter').value=me.social?.twitter||'';$('#s-instagram').value=me.social?.instagram||'';$('#s-snapchat').value=me.social?.snapchat||'';$('#s-tiktok').value=me.social?.tiktok||'';
  $('#pf-storynotify').checked=me.storyNotify!==false;
  $('#modal-profile').classList.remove('hidden');closeDrawers();}
$('#pf-save').onclick=async()=>{const avatar=$('#avatar-pick .sel')?.textContent||me.avatar;const color=rgbToHex($('#color-pick .sel')?.style.background||me.color);
  const social={twitter:$('#s-twitter').value,instagram:$('#s-instagram').value,snapchat:$('#s-snapchat').value,tiktok:$('#s-tiktok').value};
  try{const d=await api('/api/me',{method:'PUT',body:JSON.stringify({display:$('#pf-display').value,avatar,color,vibe:$('#pf-vibe').value,bio:$('#pf-bio').value,country:$('#pf-country').value,social,storyNotify:$('#pf-storynotify').checked})});Object.assign(me,d.user);renderMe();closeModal('#modal-profile');toast('تم الحفظ');}catch(e){toast(e.message);}};
$('#pf-logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload();};
function rgbToHex(c){if(c.startsWith('#'))return c;const m=c.match(/\d+/g);if(!m)return me.color;return'#'+m.slice(0,3).map(n=>(+n).toString(16).padStart(2,'0')).join('');}

/* ───── متصفّح الغرف + غرفة جديدة ───── */
$('#btn-browse').onclick=openRooms;$('#nav-rooms').onclick=openRooms;
function openRooms(){renderRoomsGrid();$('#modal-rooms').classList.remove('hidden');closeDrawers();}
function renderRoomsGrid(){const g=$('#rooms-grid');g.textContent='';for(const r of(window._rooms||[])){const el=document.createElement('div');el.className='room-row';
  const ic=document.createElement('div');ic.className='room-ic';ic.textContent=r.icon;
  const meta=document.createElement('div');meta.className='room-meta';const nm=document.createElement('div');nm.className='room-nm';nm.textContent=r.name;const k=document.createElement('div');k.className='room-kind';k.textContent=(r.kind==='voice'?'🎙️ صوتية · '+r.seats+' مقاعد':'💬 كتابية')+(r.topic?' · '+r.topic:'');meta.append(nm,k);
  const cap=document.createElement('div');cap.className='room-cap'+(r.online>=r.capacity?' full':'');cap.textContent=r.online+'/'+r.capacity;
  el.append(ic,meta,cap);el.onclick=()=>{joinRoom(r.id);closeModal('#modal-rooms');};g.appendChild(el);}}
$('#btn-newroom').onclick=()=>{const p=$('#room-icon-pick');p.textContent='';['💬','🌙','✨','🎙️','🎮','☕','🎵','📚','🔥','💜','🌊','🎭'].forEach((a,i)=>{const s=document.createElement('span');s.textContent=a;if(i===0)s.classList.add('sel');s.onclick=()=>{$$('#room-icon-pick span').forEach(x=>x.classList.remove('sel'));s.classList.add('sel');};p.appendChild(s);});$('#nr-name').value='';$('#nr-topic').value='';$('#nr-welcome').value='';$('#modal-newroom').classList.remove('hidden');};
$('#nr-create').onclick=async()=>{const icon=$('#room-icon-pick .sel')?.textContent||'💬';try{const d=await api('/api/rooms',{method:'POST',body:JSON.stringify({name:$('#nr-name').value,topic:$('#nr-topic').value,icon,kind:$('#nr-kind').value,capacity:+$('#nr-cap').value,seats:+$('#nr-seats').value,welcome:$('#nr-welcome').value})});closeModal('#modal-newroom');closeModal('#modal-rooms');await refreshRoomList();joinRoom(d.room.id);toast('تم إنشاء الغرفة');}catch(e){toast(e.message);}};

/* ───── الحائط ───── */
$('#nav-wall').onclick=openWall;
async function openWall(){$('#modal-wall').classList.remove('hidden');closeDrawers();try{const d=await api('/api/wall');const l=$('#wall-list');l.textContent='';d.posts.forEach(p=>l.appendChild(wallEl(p)));}catch(e){toast(e.message);}}
function wallEl(p){const el=document.createElement('div');el.className='wall-post';el.dataset.id=p.id;
  const h=document.createElement('div');h.className='wall-ph';const av=document.createElement('div');av.className='m-av';av.textContent=p.author?.avatar||'👤';const b=document.createElement('b');b.textContent=p.author?.display||'مجهول';if(p.author)b.style.color=p.author.color;const t=document.createElement('small');t.textContent=timeStr(p.createdAt);h.append(av,b,flagEl(p.author?.country),t);
  const body=document.createElement('div');body.className='wall-body';renderText(body,p.body);
  const foot=document.createElement('div');foot.className='wall-foot';
  const like=document.createElement('button');like.className='wall-like'+(p.likedByMe?' liked':'');like.dataset.id=p.id;const sp=document.createElement('span');sp.textContent=p.likes;like.append(document.createTextNode('❤️ '),sp);
  like.onclick=async()=>{try{const r=await api('/api/wall/'+p.id+'/like',{method:'POST'});like.classList.toggle('liked',r.likedByMe);sp.textContent=r.likes;}catch{}};
  foot.appendChild(like);
  if(p.author?.id===me.id||me.role==='owner'||me.role==='admin'){const del=mkBtn('🗑 حذف',async()=>{if(confirm('حذف المنشور؟')){await api('/api/wall/'+p.id,{method:'DELETE'});el.remove();}},'wall-del');foot.appendChild(del);}
  el.append(h,body,foot);return el;}
function prependWall(p){if($('#modal-wall').classList.contains('hidden'))return;$('#wall-list').prepend(wallEl(p));}
$('#wall-post').onclick=async()=>{const body=$('#wall-input').value.trim();if(!body)return;try{await api('/api/wall',{method:'POST',body:JSON.stringify({body})});$('#wall-input').value='';toast('تم النشر');}catch(e){toast(e.message);}};

/* ───── الخاص ───── */
$('#nav-dm').onclick=()=>{if(dmPeer)openDM(dmPeer);else toast('افتح بروفايل عضو واضغط «خاص»');};
async function openDM(u){dmPeer={id:u.id,display:u.display};$('#dm-title').textContent='✉️ خاص مع '+u.display;$('#modal-dm').classList.remove('hidden');closeDrawers();
  try{const d=await api('/api/dm/'+u.id);const l=$('#dm-list');l.textContent='';d.messages.forEach(appendDM);l.scrollTop=l.scrollHeight;refreshDmBadge();}catch(e){toast(e.message);}}
function appendDM(m){const l=$('#dm-list');const el=document.createElement('div');el.className='dm-msg '+(m.mine?'mine':'theirs');el.textContent=m.body;l.appendChild(el);l.scrollTop=l.scrollHeight;}
$('#dm-form').onsubmit=e=>{e.preventDefault();const v=$('#dm-input').value.trim();if(!v||!dmPeer)return;socket.emit('dm:send',{toId:dmPeer.id,body:v},res=>{if(res?.error)return toast(res.error);appendDM(res.msg);});$('#dm-input').value='';};
async function refreshDmBadge(){try{const d=await api('/api/me');const n=(d.inbox||[]).reduce((a,b)=>a+b.c,0);const bd=$('#dm-badge');bd.textContent=n;bd.classList.toggle('hidden',!n);}catch{}}

/* ───── تنقّل/ثيم/جوال/صوت ───── */
$('#btn-theme').onclick=()=>{const i=THEMES.indexOf(document.body.dataset.theme);const n=THEMES[(i+1)%THEMES.length];document.body.dataset.theme=n;localStorage.setItem('layl-theme',n);toast('الثيم: '+n);};
$('#btn-menu').onclick=()=>$('#side').classList.add('open');
$('#btn-members').onclick=()=>$('#members').classList.toggle('open');
$('#nav-members').onclick=()=>$('#members').classList.toggle('open');
$('#members-close').onclick=()=>$('#members').classList.remove('open');
function closeDrawers(){$('#side').classList.remove('open');$('#members').classList.remove('open');}
function closeModal(sel){$(sel).classList.add('hidden');}
$$('.modal-close').forEach(b=>b.onclick=()=>b.closest('.modal').classList.add('hidden'));
$$('.modal').forEach(m=>m.onclick=e=>{if(e.target===m)m.classList.add('hidden');});
$('#btn-search').onclick=()=>{$('#search-bar').classList.toggle('hidden');$('#search-input').focus();};
$('#search-close').onclick=()=>{$('#search-bar').classList.add('hidden');$('#search-input').value='';joinRoom(currentRoom.id);};
let searchT;$('#search-input').oninput=e=>{clearTimeout(searchT);const q=e.target.value.trim();searchT=setTimeout(async()=>{if(!q)return;try{const d=await api(`/api/rooms/${currentRoom.id}/messages?q=${encodeURIComponent(q)}`);const box=$('#messages');box.textContent='';lastAuthor=null;if(!d.messages.length)appendSystem('لا نتائج');d.messages.forEach(appendMsg);}catch{}},300);};

let audioCtx;function beep(){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=660;o.type='sine';g.gain.setValueAtTime(.06,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.3);o.start();o.stop(audioCtx.currentTime+.3);}catch{}}

/* ───── الستوري / الحالات ───── */
const SBG = ['g1','g2','g3','g4','g5','g6'];
let storyGroups = [];
function relTime(ts){const m=Math.floor((Date.now()-ts)/60000);if(m<1)return 'الآن';if(m<60)return `قبل ${m} د`;const h=Math.floor(m/60);if(h<24)return `قبل ${h} س`;return `قبل ${Math.floor(h/24)} ي`;}
async function loadStories(){try{const d=await api('/api/stories');storyGroups=d.groups;renderStoryBar();}catch{}}
function renderStoryBar(){const bar=$('#story-bar');bar.textContent='';
  // عنصر الإضافة (حالتي)
  const mine=storyGroups.find(g=>g.user.id===me.id);
  const add=document.createElement('div');add.className='story-item story-add';
  const ar=document.createElement('div');ar.className='story-ring'+(mine?' mine has':'');const as=document.createElement('span');as.textContent=mine?me.avatar:'＋';ar.appendChild(as);
  const ac=document.createElement('div');ac.className='story-cap';ac.textContent=mine?'حالتي':'أضف حالة';
  add.append(ar,ac);add.onclick=()=>mine?openStory(me.id):openAddStory();
  bar.appendChild(add);
  for(const g of storyGroups){if(g.user.id===me.id)continue;
    const it=document.createElement('div');it.className='story-item';
    const r=document.createElement('div');r.className='story-ring'+(g.seen?'':' unseen');const s=document.createElement('span');s.textContent=g.user.avatar;r.appendChild(s);
    const c=document.createElement('div');c.className='story-cap';c.textContent=g.user.display;
    it.append(r,c);it.onclick=()=>openStory(g.user.id);bar.appendChild(it);}
}
// إضافة حالة
let asBg='g1';
function openAddStory(){asBg='g1';$('#as-body').value='';updateStoryPreview();
  const p=$('#bg-pick');p.textContent='';SBG.forEach((k,i)=>{const s=document.createElement('span');s.style.background='var(--s'+k+')';if(i===0)s.classList.add('sel');s.onclick=()=>{asBg=k;$$('#bg-pick span').forEach(x=>x.classList.remove('sel'));s.classList.add('sel');updateStoryPreview();};p.appendChild(s);});
  $('#modal-addstory').classList.remove('hidden');closeDrawers();}
function updateStoryPreview(){const pv=$('#story-preview');pv.style.background='var(--s'+asBg+')';$('#story-preview-text').textContent=$('#as-body').value||'معاينة…';}
$('#as-body').addEventListener('input',updateStoryPreview);
$('#as-post').onclick=async()=>{const body=$('#as-body').value.trim();if(!body)return toast('اكتب نص الحالة');try{await api('/api/stories',{method:'POST',body:JSON.stringify({body,bg:asBg})});closeModal('#modal-addstory');toast('نُشرت حالتك 🌙');loadStories();}catch(e){toast(e.message);}};
// عرض الحالات
let svStories=[],svIdx=0,svTimer=null,svOwner=false;
async function openStory(userId){try{const d=await api('/api/stories/user/'+userId);if(!d.stories.length)return toast('لا توجد حالات');
  svStories=d.stories;svOwner=d.owner;svIdx=0;
  $('#sv-av').textContent=d.author?.avatar||'🌙';$('#sv-name').textContent=d.author?.display||'';if(d.author)$('#sv-name').style.color=d.author.color;
  $('#modal-story').classList.remove('hidden');closeDrawers();showStory(0);
}catch(e){toast(e.message);}}
function showStory(i){if(i<0)i=0;if(i>=svStories.length){closeStory();loadStories();return;}svIdx=i;const s=svStories[i];
  const c=$('#sv-content');c.textContent=s.body;c.style.background='var(--s'+s.bg+')';
  $('#sv-time').textContent=relTime(s.createdAt);
  const bars=$('#sv-bars');bars.textContent='';svStories.forEach((_,k)=>{const b=document.createElement('div');b.className='sv-bar'+(k<i?' done':k===i?' active':'');const fill=document.createElement('i');b.appendChild(fill);bars.appendChild(b);});
  const foot=$('#sv-foot');foot.textContent='';
  if(svOwner){foot.appendChild(mkBtn(`👁️ المشاهدون (${s.views})`,()=>openViewers(s.id)));
    foot.appendChild(mkBtn('🗑️ حذف الحالة',async()=>{if(confirm('حذف؟')){await api('/api/stories/'+s.id,{method:'DELETE'});svStories.splice(i,1);if(!svStories.length){closeStory();loadStories();}else showStory(Math.min(i,svStories.length-1));}}));}
  clearTimeout(svTimer);svTimer=setTimeout(()=>showStory(i+1),5000);}
function closeStory(){clearTimeout(svTimer);$('#modal-story').classList.add('hidden');}
$('#sv-next').onclick=()=>showStory(svIdx+1);
$('#sv-prev').onclick=()=>showStory(svIdx-1);
$('#modal-story').querySelector('.modal-close').onclick=()=>{closeStory();loadStories();};
async function openViewers(storyId){try{const d=await api('/api/stories/'+storyId+'/viewers');const l=$('#viewers-list');l.textContent='';
  if(!d.viewers.length){const e=document.createElement('div');e.className='member';e.textContent='لا أحد بعد 🌙';l.appendChild(e);}
  for(const v of d.viewers){const el=document.createElement('div');el.className='member';const av=document.createElement('div');av.className='m-av';av.textContent=v.avatar;av.style.background='transparent';const info=document.createElement('div');info.className='member-info';const nm=document.createElement('div');nm.className='member-nm';const t=document.createElement('span');t.textContent=v.display;t.style.color=v.color;nm.append(t,flagEl(v.country));const sub=document.createElement('div');sub.className='member-vibe';sub.textContent=relTime(v.at);info.append(nm,sub);el.append(av,info);l.appendChild(el);}
  $('#modal-viewers').classList.remove('hidden');}catch(e){toast(e.message);}}

/* ───── إحصاءات الصوت (للتشخيص) ───── */
window.laylVoice=()=>({speaker:iAmSpeaker,send:[...sendPcs.values()].map(p=>p.connectionState),recv:[...recvPcs.values()].map(p=>p.connectionState),audios:remoteAudios.size});

/* ───── إقلاع ───── */
api('/api/me').then(d=>enter(d.user)).catch(()=>{});
})();
